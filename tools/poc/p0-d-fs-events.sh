#!/usr/bin/env bash
# P0-D — prove ADR-0011 (filesystem event capture) and the ADR-0005 identity annex.
#
# This is the second gate that must pass before Phase 1 indexer code is written.
#
# ADR-0011 inverted the Phase 0 kickoff assumption: Samba `vfs_full_audit` became the PRIMARY
# event source and fanotify was demoted to an optional Layer 2. That inversion is only safe if
# Layer 1 actually delivers what the ADR claims, so this script spends as much effort on the
# boring syslog path as on the exciting kernel one.
#
# The single decisive unknown is narrow and old: openzfs#6079 (mocukie, 2020-12-02) reported that
# fanotify FID mode returns a `fanotify_event_info_fid` that is not correctly populated on ZFS.
# The 2024 "it works now" confirmations were all made with fatrace, i.e. legacy path/mount marks —
# nobody re-tested FID mode after the 2.2.x fixes. A mark that succeeds proves nothing on its own:
# the kernel gates are `exportfs_can_encode_fid()` and a non-zero fsid, and ZFS passes both on
# paper. What must be checked is whether the handles that come out the other end are real. So this
# script does not stop at "mark returned 0" — it feeds every handle back through
# open_by_handle_at(2) and demands a path.
#
# ADR-0005 rides on the same machinery: its reconciliation step 2 joins external changes to DB
# rows on (dataset_id, inode, generation). If ZFS generation is unavailable, or too coarse to
# distinguish a deleted file from its replacement, that join silently binds a dead file's ACL to
# an unrelated new file. That is a silent authority transfer, not a cosmetic bug, so it is tested
# here rather than discovered in Phase 2.

POC_ID=p0-d
# shellcheck source=lib/common.sh
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"

require_test_environment

TEST_USER=depsis_poc_dana
SMB_PASS='P0d-Test-Pw!2026'
SMB_SHARE=p0dshare

PARENT_DS="$DEPSIS_TEST_POOL/fsev"
PARENT_PATH="$DEPSIS_POC_ROOT/fsev"
CHILD_DS="$PARENT_DS/child"
CHILD_PATH="$PARENT_PATH/child"
SHARE_DS="$DEPSIS_TEST_POOL/share"
SHARE_PATH="$DEPSIS_POC_ROOT/share"

PROBE_DIR=/tmp/p0d-probes
FANPROBE="$PROBE_DIR/fanprobe"
FIDPROBE="$PROBE_DIR/fidprobe"
FAN_OUT=/tmp/p0d-fanotify.out

# Bulk file count for the inode-reuse hunt. Large enough that the ZFS dnode allocator has a real
# chance to hand the freed object number back, small enough to keep the run under a minute.
REUSE_N=20000

cleanup() {
  section 'Cleanup'
  # smbd holds an fd on the share mountpoint; the pool cannot be destroyed while it does.
  systemctl stop smbd >/dev/null 2>&1 || true
  if [ -f /etc/samba/smb.conf.p0d-backup ]; then
    mv -f /etc/samba/smb.conf.p0d-backup /etc/samba/smb.conf || true
  fi
  smbpasswd -x "$TEST_USER" >/dev/null 2>&1 || true
  cd / || true
  cleanup_pool || true
  systemctl start smbd >/dev/null 2>&1 || true
  userdel "$TEST_USER" >/dev/null 2>&1 || true
  rm -rf "$PROBE_DIR" || true
  rm -f /tmp/p0d-*.out /tmp/p0d-*.txt /tmp/p0d-*.log /tmp/p0d-*.err || true
}
trap cleanup EXIT

# ─── 0. environment ───────────────────────────────────────────────────────────
section 'Environment'
note "zfs version: $(zfs version 2>&1 | head -1)"
note "kernel: $(uname -r)"
note "zfsutils package: $(dpkg-query -W -f='${Version}' zfsutils-linux 2>/dev/null || echo '?')"
note "samba package: $(dpkg-query -W -f='${Version}' samba 2>/dev/null || echo 'not installed')"
# Layer 3 delegation is only usable if an unprivileged process can open the control device at all.
note "/dev/zfs: $(stat -c '%a %U:%G' /dev/zfs 2>/dev/null || echo 'absent')"

# Scope honesty: two items from ADR-0011's P0-D list are deliberately NOT covered here, and
# claiming otherwise would be worse than skipping them.
note 'NOT COVERED by this script: ADR-0011 P0-D item 5 (200k-file bulk load -> FAN_Q_OVERFLOW)'
note 'NOT COVERED by this script: ADR-0011 P0-D item 7 (1M-file cold-cache zfs diff)'

mapfile -t VDEVS < <(poc_vdevs 2)
[ "${#VDEVS[@]}" -ge 2 ] || { fail 'need 2 vdev disks'; poc_summary; exit 1; }
note "vdevs: ${VDEVS[*]}"

cd /
cleanup_pool
zpool create -f -m "$DEPSIS_POC_ROOT" "$DEPSIS_TEST_POOL" mirror "${VDEVS[0]}" "${VDEVS[1]}"
pass 'created mirror test pool'

# The child dataset must exist and be mounted BEFORE the filesystem-wide mark is placed —
# otherwise section 2 would be measuring a race instead of superblock scope.
zfs create -o mountpoint="$PARENT_PATH" -o acltype=posixacl -o xattr=sa "$PARENT_DS"
zfs create -o mountpoint="$CHILD_PATH" "$CHILD_DS"
zfs create -o mountpoint="$SHARE_PATH" -o acltype=posixacl -o xattr=sa "$SHARE_DS"
pass 'created parent / child / share datasets'

id "$TEST_USER" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin "$TEST_USER"

# ─── field extractors ─────────────────────────────────────────────────────────
# Pure bash, no pipes: `set -o pipefail` plus `sed | head -1` is a SIGPIPE trap that would abort
# the run on a perfectly good parse.
fan_field() { # <space-separated line> <key> -> value
  local tok
  for tok in $1; do
    case "$tok" in "$2="*) printf '%s\n' "${tok#"$2"=}"; return 0 ;; esac
  done
  printf '\n'
}

fp_field() { # <multi-line key=value blob> <key> -> value
  local line
  while IFS= read -r line; do
    case "$line" in "$2="*) printf '%s\n' "${line#"$2"=}"; return 0 ;; esac
  done <<<"$1"
  printf '\n'
}

# ═══════════════════════════════════════════════════════════════════════════════
section '0b. Build the C probes'
# ═══════════════════════════════════════════════════════════════════════════════
# Everything decisive in this PoC needs raw errno values and raw file handles. Shell cannot see
# either: `fanotify` has no CLI, and the difference between "handle_bytes==0" and "a handle that
# actually resolves" is exactly the difference between ADR-0011 Layer 2 being alive or dead.

HAVE_C=0
if ! command -v gcc >/dev/null 2>&1; then
  warn 'gcc is NOT installed — sections 1..4 cannot run'
  note 'C PROBES SKIPPED: the decisive fanotify FID test and the handle/generation tests are UNPROVEN'
else
  mkdir -p "$PROBE_DIR"

  cat >"$PROBE_DIR/fanprobe.c" <<'CEOF'
/* fanprobe — ADR-0011 §P0-D item 1 and 2.
 *
 * Places exactly the mark ADR-0011 Layer 2 specifies, performs create/rename/unlink on each
 * target path, then drains the queue and tries to turn every reported file handle back into a
 * path with open_by_handle_at(2). "Mark succeeded" is not the result; "the handle resolved" is.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/fanotify.h>
#include <sys/stat.h>

/* Guarded because a stale libc header would otherwise silently build a probe that tests
 * something other than what ADR-0011 specifies. Values are from uapi/linux/fanotify.h. */
#ifndef FAN_REPORT_DFID_NAME
#define FAN_REPORT_DFID_NAME 0x00000c00
#endif
#ifndef FAN_RENAME
#define FAN_RENAME 0x10000000
#endif
#ifndef FAN_EVENT_INFO_TYPE_FID
#define FAN_EVENT_INFO_TYPE_FID 1
#endif
#ifndef FAN_EVENT_INFO_TYPE_DFID_NAME
#define FAN_EVENT_INFO_TYPE_DFID_NAME 2
#endif
#ifndef FAN_EVENT_INFO_TYPE_DFID
#define FAN_EVENT_INFO_TYPE_DFID 3
#endif
#ifndef FAN_EVENT_INFO_TYPE_OLD_DFID_NAME
#define FAN_EVENT_INFO_TYPE_OLD_DFID_NAME 10
#endif
#ifndef FAN_EVENT_INFO_TYPE_NEW_DFID_NAME
#define FAN_EVENT_INFO_TYPE_NEW_DFID_NAME 12
#endif

#define HMAX 128

static const char *itype_name(int t)
{
	switch (t) {
	case FAN_EVENT_INFO_TYPE_FID:           return "FID";
	case FAN_EVENT_INFO_TYPE_DFID:          return "DFID";
	case FAN_EVENT_INFO_TYPE_DFID_NAME:     return "DFID_NAME";
	case FAN_EVENT_INFO_TYPE_OLD_DFID_NAME: return "OLD_DFID_NAME";
	case FAN_EVENT_INFO_TYPE_NEW_DFID_NAME: return "NEW_DFID_NAME";
	default:                                return "OTHER";
	}
}

static int itype_has_name(int t)
{
	return t == FAN_EVENT_INFO_TYPE_DFID_NAME ||
	       t == FAN_EVENT_INFO_TYPE_OLD_DFID_NAME ||
	       t == FAN_EVENT_INFO_TYPE_NEW_DFID_NAME;
}

static void mask_str(uint64_t m, char *out, size_t n)
{
	struct { uint64_t bit; const char *nm; } t[] = {
		{ FAN_CREATE, "CREATE" }, { FAN_DELETE, "DELETE" },
		{ FAN_MOVED_FROM, "MOVED_FROM" }, { FAN_MOVED_TO, "MOVED_TO" },
		{ FAN_RENAME, "RENAME" }, { FAN_CLOSE_WRITE, "CLOSE_WRITE" },
		{ FAN_ATTRIB, "ATTRIB" }, { FAN_ONDIR, "ONDIR" },
		{ FAN_Q_OVERFLOW, "Q_OVERFLOW" },
	};
	size_t i, used = 0;
	out[0] = '\0';
	for (i = 0; i < sizeof(t) / sizeof(t[0]); i++) {
		if (!(m & t[i].bit))
			continue;
		used += (size_t)snprintf(out + used, used < n ? n - used : 0,
					 "%s%s", used ? "," : "", t[i].nm);
		if (used >= n)
			return;
	}
	if (!out[0])
		snprintf(out, n, "none");
}

int main(int argc, char **argv)
{
	int fd, mrc, e, mountfd, i;
	int events = 0, infos = 0, empty = 0, resolved = 0, overflow = 0;
	char buf[65536];

	if (argc < 3) {
		fprintf(stderr, "usage: fanprobe <mark_path> <target_file>...\n");
		return 2;
	}

	fd = fanotify_init(FAN_CLASS_NOTIF | FAN_REPORT_DFID_NAME | FAN_NONBLOCK,
			   O_RDONLY | O_LARGEFILE);
	e = (fd < 0) ? errno : 0;
	printf("INIT rc=%d errno=%d msg=%s\n", fd, e, e ? strerror(e) : "ok");
	if (fd < 0)
		return 3;

	mrc = fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
			    FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO |
			    FAN_RENAME | FAN_CLOSE_WRITE | FAN_ATTRIB | FAN_ONDIR,
			    AT_FDCWD, argv[1]);
	e = (mrc < 0) ? errno : 0;
	printf("MARK rc=%d errno=%d msg=%s\n", mrc, e, e ? strerror(e) : "ok");
	if (mrc < 0)
		return 4;

	/* Any fd on the marked filesystem works as the open_by_handle_at anchor. */
	mountfd = open(argv[1], O_RDONLY | O_DIRECTORY);
	if (mountfd < 0)
		printf("MOUNTFD rc=-1 errno=%d\n", errno);

	for (i = 2; i < argc; i++) {
		char renamed[4096];
		int t;
		snprintf(renamed, sizeof renamed, "%s.renamed", argv[i]);
		t = open(argv[i], O_CREAT | O_WRONLY | O_TRUNC, 0644);
		if (t < 0) {
			printf("OPFAIL op=create path=%s errno=%d\n", argv[i], errno);
			continue;
		}
		if (write(t, "depsis", 6) < 0)
			printf("OPFAIL op=write path=%s errno=%d\n", argv[i], errno);
		close(t);
		if (rename(argv[i], renamed) != 0)
			printf("OPFAIL op=rename path=%s errno=%d\n", argv[i], errno);
		else if (unlink(renamed) != 0)
			printf("OPFAIL op=unlink path=%s errno=%d\n", renamed, errno);
	}

	for (;;) {
		ssize_t len;
		struct pollfd pfd;
		struct fanotify_event_metadata *meta;

		pfd.fd = fd;
		pfd.events = POLLIN;
		pfd.revents = 0;
		if (poll(&pfd, 1, 2000) <= 0)
			break;
		len = read(fd, buf, sizeof buf);
		if (len <= 0)
			break;

		meta = (struct fanotify_event_metadata *)buf;
		while (FAN_EVENT_OK(meta, len)) {
			char ms[256];
			char *p, *end;

			events++;
			mask_str((uint64_t)meta->mask, ms, sizeof ms);
			if (meta->mask & FAN_Q_OVERFLOW)
				overflow++;
			printf("EVENT mask=0x%llx flags=%s eventlen=%u\n",
			       (unsigned long long)meta->mask, ms, meta->event_len);

			p   = (char *)meta + meta->metadata_len;
			end = (char *)meta + meta->event_len;
			while (p + (long)sizeof(struct fanotify_event_info_header) <= end) {
				struct fanotify_event_info_header *hdr;
				struct fanotify_event_info_fid *fid;
				struct file_handle *fh;
				const char *name = "-";
				char hex[2 * HMAX + 1];
				unsigned k, n;
				int allzero = 1, rerr = 0;
				char link[4096];
				const char *res = "-";

				hdr = (struct fanotify_event_info_header *)p;
				if (hdr->len < sizeof(*hdr) || p + hdr->len > end)
					break;
				if (hdr->info_type != FAN_EVENT_INFO_TYPE_FID &&
				    hdr->info_type != FAN_EVENT_INFO_TYPE_DFID &&
				    !itype_has_name(hdr->info_type)) {
					printf("INFO type=%d typename=%s skipped=1\n",
					       hdr->info_type, itype_name(hdr->info_type));
					p += hdr->len;
					continue;
				}

				fid = (struct fanotify_event_info_fid *)hdr;
				fh  = (struct file_handle *)fid->handle;
				infos++;

				if (itype_has_name(hdr->info_type)) {
					char *np = (char *)fh->f_handle + fh->handle_bytes;
					if (np < end)
						name = np;
				}

				hex[0] = '\0';
				n = fh->handle_bytes > HMAX ? HMAX : fh->handle_bytes;
				for (k = 0; k < n; k++) {
					sprintf(hex + 2 * k, "%02x", fh->f_handle[k]);
					if (fh->f_handle[k])
						allzero = 0;
				}
				/* This is the openzfs#6079 symptom: a mark that works but a fid
				 * that is empty or all-zero. Count it, do not let it slide. */
				if (fh->handle_bytes == 0 || allzero)
					empty++;

				if (mountfd >= 0 && fh->handle_bytes > 0 && !allzero) {
					int ofd = open_by_handle_at(mountfd, fh,
								    O_RDONLY | O_PATH);
					if (ofd >= 0) {
						char proc[64];
						ssize_t ln;
						resolved++;
						snprintf(proc, sizeof proc,
							 "/proc/self/fd/%d", ofd);
						ln = readlink(proc, link, sizeof link - 1);
						if (ln > 0) {
							link[ln] = '\0';
							res = link;
						}
						close(ofd);
					} else {
						rerr = errno;
					}
				}

				printf("INFO type=%d typename=%s fsid=%08x%08x hbytes=%u htype=%d "
				       "handle=%s name=%s resolved=%s reserrno=%d\n",
				       hdr->info_type, itype_name(hdr->info_type),
				       (unsigned)fid->fsid.val[0], (unsigned)fid->fsid.val[1],
				       fh->handle_bytes, fh->handle_type,
				       hex[0] ? hex : "-", name, res, rerr);

				p += hdr->len;
			}
			meta = FAN_EVENT_NEXT(meta, len);
		}
	}

	printf("SUMMARY events=%d infos=%d empty_handles=%d resolved=%d overflow=%d\n",
	       events, infos, empty, resolved, overflow);
	if (mountfd >= 0)
		close(mountfd);
	close(fd);
	return 0;
}
CEOF

  cat >"$PROBE_DIR/fidprobe.c" <<'CEOF'
/* fidprobe — ADR-0005 §P0-D annex items 2 and 3.
 *
 *   fidprobe stat <path>                     -> ino / generation / fsid / file handle
 *   fidprobe open <mountpoint> <htype> <hex> -> open_by_handle_at round trip
 *
 * statx(2) has no generation field, so FS_IOC_GETVERSION is the only way to read i_generation
 * from userspace. ZFS implements it (zpl_ioctl_getversion) because NFS export needs the same
 * counter, but that is an implementation detail we verify rather than assume: genrc/generrno are
 * reported so the caller can say "generation is unavailable" out loud instead of printing 0.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>

/* Buffer we allocate. Deliberately larger than the kernel limit so a bad reply cannot
 * overflow it. */
#define HBUF 256

/* The kernel's MAX_HANDLE_SZ. name_to_handle_at returns EINVAL for any handle_bytes above
 * this, so the value DECLARED to the kernel must be capped here even though our buffer is
 * bigger. Declaring HBUF was the bug that made the whole handle section report EINVAL. */
#define HANDLE_MAX 128

static int hexval(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

static int hex2bin(const char *hex, unsigned char *out, unsigned max)
{
	unsigned i, len = (unsigned)strlen(hex);
	if (len % 2 || len / 2 > max)
		return -1;
	for (i = 0; i < len / 2; i++) {
		int hi = hexval(hex[2 * i]), lo = hexval(hex[2 * i + 1]);
		if (hi < 0 || lo < 0)
			return -1;
		out[i] = (unsigned char)((hi << 4) | lo);
	}
	return (int)(len / 2);
}

static int do_stat(const char *path)
{
	struct stat st;
	struct statfs sfs;
	char buf[sizeof(struct file_handle) + HBUF];
	struct file_handle *fh = (struct file_handle *)buf;
	char hex[2 * HBUF + 1];
	unsigned f0 = 0, f1 = 0, i;
	long gen = -1;
	int genrc = -1, generr = 0, fd, mid = -1, nrc, nerr;

	if (stat(path, &st) != 0) {
		printf("statrc=-1\nstaterrno=%d\n", errno);
		return 1;
	}
	if (statfs(path, &sfs) == 0) {
		f0 = (unsigned)sfs.f_fsid.__val[0];
		f1 = (unsigned)sfs.f_fsid.__val[1];
	}

	fd = open(path, O_RDONLY | O_NONBLOCK);
	if (fd >= 0) {
		unsigned int v = 0;
		genrc = ioctl(fd, FS_IOC_GETVERSION, &v);
		if (genrc == 0)
			gen = (long)v;
		else
			generr = errno;
		close(fd);
	} else {
		generr = errno;
	}

	/* handle_bytes is the CAPACITY DECLARED TO THE KERNEL, not the size of our buffer.
	 * The kernel rejects anything above MAX_HANDLE_SZ (128) with EINVAL, so passing HBUF
	 * (256) here made every call fail with errno=22 and produced three cascading false
	 * failures: "ZFS cannot use file handles at all", plus two bad-hex round-trip errors.
	 * ZFS handles are in fact 12 bytes and work fine — fanotify in section 1 was resolving
	 * them in the same run, which is what exposed the contradiction.
	 *
	 * Use the documented two-call protocol: ask with 0 to learn the required size (the
	 * kernel answers EOVERFLOW, which is success for that step), then request exactly that. */
	fh->handle_bytes = 0;
	nrc = name_to_handle_at(AT_FDCWD, path, fh, &mid, 0);
	if (nrc < 0 && errno == EOVERFLOW && fh->handle_bytes > 0 && fh->handle_bytes <= HANDLE_MAX) {
		nrc = name_to_handle_at(AT_FDCWD, path, fh, &mid, 0);
	} else if (nrc < 0) {
		fh->handle_bytes = HANDLE_MAX;
		nrc = name_to_handle_at(AT_FDCWD, path, fh, &mid, 0);
	}
	nerr = (nrc < 0) ? errno : 0;
	hex[0] = '\0';
	if (nrc == 0) {
		unsigned n = fh->handle_bytes > HBUF ? HBUF : fh->handle_bytes;
		for (i = 0; i < n; i++)
			sprintf(hex + 2 * i, "%02x", fh->f_handle[i]);
	}

	printf("statrc=0\n");
	printf("path=%s\n", path);
	printf("ino=%llu\n", (unsigned long long)st.st_ino);
	printf("dev=%llu\n", (unsigned long long)st.st_dev);
	printf("nlink=%llu\n", (unsigned long long)st.st_nlink);
	printf("fsid=%08x%08x\n", f0, f1);
	printf("genrc=%d\n", genrc);
	printf("generrno=%d\n", generr);
	printf("gen=%ld\n", gen);
	printf("nthrc=%d\n", nrc);
	printf("ntherrno=%d\n", nerr);
	printf("mntid=%d\n", mid);
	printf("htype=%d\n", nrc == 0 ? fh->handle_type : -1);
	printf("hbytes=%u\n", nrc == 0 ? fh->handle_bytes : 0u);
	printf("handle=%s\n", hex[0] ? hex : "-");
	return 0;
}

static int do_open(const char *mountpath, int htype, const char *hex)
{
	char buf[sizeof(struct file_handle) + HBUF];
	struct file_handle *fh = (struct file_handle *)buf;
	int n, mfd, fd, e;

	n = hex2bin(hex, (unsigned char *)fh->f_handle, HBUF);
	if (n < 0) {
		printf("rc=-1\nerrno=0\nmsg=bad-hex\n");
		return 2;
	}
	fh->handle_bytes = (unsigned)n;
	fh->handle_type  = htype;

	mfd = open(mountpath, O_RDONLY | O_DIRECTORY);
	if (mfd < 0) {
		printf("rc=-1\nerrno=%d\nmsg=mount-open-failed\n", errno);
		return 3;
	}
	fd = open_by_handle_at(mfd, fh, O_RDONLY | O_PATH);
	e  = (fd < 0) ? errno : 0;
	printf("rc=%d\n", fd < 0 ? -1 : 0);
	printf("errno=%d\n", e);
	printf("msg=%s\n", e ? strerror(e) : "ok");
	if (fd >= 0) {
		char proc[64], link[4096];
		struct stat st;
		ssize_t ln;
		snprintf(proc, sizeof proc, "/proc/self/fd/%d", fd);
		ln = readlink(proc, link, sizeof link - 1);
		if (ln > 0) {
			link[ln] = '\0';
			printf("resolved=%s\n", link);
		} else {
			printf("resolved=-\n");
		}
		if (fstat(fd, &st) == 0)
			printf("ino=%llu\n", (unsigned long long)st.st_ino);
		close(fd);
	}
	close(mfd);
	return 0;
}

int main(int argc, char **argv)
{
	if (argc >= 3 && strcmp(argv[1], "stat") == 0)
		return do_stat(argv[2]);
	if (argc >= 5 && strcmp(argv[1], "open") == 0)
		return do_open(argv[2], atoi(argv[3]), argv[4]);
	fprintf(stderr, "usage: fidprobe stat <path> | fidprobe open <mnt> <htype> <hex>\n");
	return 2;
}
CEOF

  cc_rc=0
  gcc -O0 -Wall -Werror=implicit-function-declaration \
      -o "$FANPROBE" "$PROBE_DIR/fanprobe.c" 2>"$PROBE_DIR/fanprobe.log" || cc_rc=$?
  gcc -O0 -Wall -Werror=implicit-function-declaration \
      -o "$FIDPROBE" "$PROBE_DIR/fidprobe.c" 2>"$PROBE_DIR/fidprobe.log" || cc_rc=$?

  if [ "$cc_rc" -eq 0 ] && [ -x "$FANPROBE" ] && [ -x "$FIDPROBE" ]; then
    HAVE_C=1
    pass 'both C probes compiled'
  else
    # A compile failure here is itself evidence: it means the trixie headers do not expose the
    # API ADR-0011 Layer 2 is specified against.
    fail 'C probes failed to compile — the fanotify/handle API is not available as specified' \
         "$(cat "$PROBE_DIR/fanprobe.log" "$PROBE_DIR/fidprobe.log" 2>/dev/null | head -20)"
  fi
fi

probe_stat() { # <path> -> multi-line key=value; empty on probe failure
  [ "$HAVE_C" -eq 1 ] || { printf '\n'; return 0; }
  "$FIDPROBE" stat "$1" 2>/dev/null || printf 'statrc=-1\n'
}

# ═══════════════════════════════════════════════════════════════════════════════
section '1. DECISIVE — does fanotify FID mode work on ZFS? (ADR-0011 P0-D item 1)'
# ═══════════════════════════════════════════════════════════════════════════════

MARK_ERRNO=''
FID_ALIVE=0
if [ "$HAVE_C" -ne 1 ]; then
  warn 'no C probe — the decisive test did not run'
  note 'ADR-0011 item 1 UNPROVEN: fanotify FID mode on ZFS was not exercised'
else
  fan_rc=0
  "$FANPROBE" "$PARENT_PATH" "$PARENT_PATH/parent-a.txt" "$CHILD_PATH/child-a.txt" \
    >"$FAN_OUT" 2>&1 || fan_rc=$?
  while IFS= read -r line; do info "$line"; done <"$FAN_OUT"

  init_line=$(grep -m1 '^INIT ' "$FAN_OUT" || true)
  mark_line=$(grep -m1 '^MARK ' "$FAN_OUT" || true)
  init_rc=$(fan_field "$init_line" rc)
  init_errno=$(fan_field "$init_line" errno)
  mark_rc=$(fan_field "$mark_line" rc)
  MARK_ERRNO=$(fan_field "$mark_line" errno)

  note "fanotify_init rc=$init_rc errno=$init_errno" "$init_line"
  note "fanotify_mark rc=$mark_rc errno=$MARK_ERRNO" "$mark_line"

  if [ "${init_rc:-0}" -lt 0 ] 2>/dev/null || [ -z "$mark_line" ]; then
    # EINVAL here almost always means FAN_REPORT_DFID_NAME is not supported by this kernel,
    # which would make Layer 2 impossible regardless of what ZFS does.
    fail "fanotify_init(FAN_CLASS_NOTIF|FAN_REPORT_DFID_NAME) failed, errno=$init_errno" \
         "$init_line"
  fi

  # ADR-0011's interpretation table. Each errno points at a different broken assumption, and
  # picking the wrong one would send Phase 1 chasing the wrong fix.
  case "${MARK_ERRNO:-0}" in
    0)
      pass 'FAN_MARK_FILESYSTEM|FAN_REPORT_DFID_NAME was ACCEPTED on a ZFS dataset' \
           'the two kernel gates (exportfs_can_encode_fid, non-zero fsid) both passed'
      ;;
    95)
      fail 'mark rejected with EOPNOTSUPP(95)' \
           'exportfs_can_encode_fid() rejected ZFS — zpl_export_operations is not being seen; Layer 2 is impossible'
      ;;
    19)
      fail 'mark rejected with ENODEV(19)' \
           'zero fsid — dmu_objset_fsid_guid() did not reach f_fsid; Layer 2 is impossible'
      ;;
    18)
      fail 'mark rejected with EXDEV(18)' \
           'multiple fsids inside one superblock — ADR-0011 claim "one dataset = one objset = one fsid" is WRONG'
      ;;
    1)
      fail 'mark rejected with EPERM(1)' \
           'missing CAP_SYS_ADMIN — this run is not privileged enough to conclude anything about ZFS'
      ;;
    *)
      fail "mark rejected with an errno outside ADR-0011's table: $MARK_ERRNO" \
           'ADR-0011 interpretation table is incomplete — extend it'
      ;;
  esac

  # Sanity: if the probe could not even create its own files, no conclusion about events is valid.
  if grep -q '^OPFAIL ' "$FAN_OUT"; then
    fail 'the probe could not perform its own file operations' \
         "$(grep '^OPFAIL ' "$FAN_OUT" | head -5)"
  fi

  if [ "${MARK_ERRNO:-0}" = "0" ]; then
    sum_line=$(grep -m1 '^SUMMARY ' "$FAN_OUT" || true)
    n_events=$(fan_field "$sum_line" events)
    n_infos=$(fan_field "$sum_line" infos)
    n_empty=$(fan_field "$sum_line" empty_handles)
    n_res=$(fan_field "$sum_line" resolved)
    note "queue drain: events=${n_events:-0} fid_records=${n_infos:-0} empty_handles=${n_empty:-0} resolved=${n_res:-0}"

    # This is the whole point of P0-D. A mark that returns 0 while producing unusable fids is the
    # exact 2020 openzfs#6079 symptom, and it is indistinguishable from success unless checked.
    if [ "${n_events:-0}" -eq 0 ]; then
      fail 'the mark succeeded but NO events were delivered for operations on the marked dataset' \
           'VFS-level fsnotify hooks are not firing — fanotify Layer 2 is DEAD on this ZFS'
      warn 'ADR-0011 Layer 2 must be struck from the design: Layer 1 + Layer 3 only.'
    elif [ "${n_infos:-0}" -eq 0 ]; then
      fail 'events arrived but carried NO fid info records' \
           'FAN_REPORT_DFID_NAME produced nothing usable — fanotify Layer 2 is DEAD'
      warn 'ADR-0011 Layer 2 must be struck from the design: Layer 1 + Layer 3 only.'
    elif [ "${n_empty:-0}" -gt 0 ]; then
      fail "${n_empty} of ${n_infos} file handles came back empty or all-zero" \
           'openzfs#6079 (mocukie, 2020-12-02) STILL STANDS on current ZFS — fanotify Layer 2 is DEAD'
      warn 'ADR-0011 Layer 2 must be struck from the design: Layer 1 + Layer 3 only.'
    elif [ "${n_res:-0}" -eq 0 ]; then
      fail "all ${n_infos} handles were non-empty but NONE resolved via open_by_handle_at" \
           'the fids are garbage — fanotify Layer 2 is DEAD'
      warn 'ADR-0011 Layer 2 must be struck from the design: Layer 1 + Layer 3 only.'
    else
      FID_ALIVE=1
      pass "fanotify FID mode WORKS on ZFS: ${n_res}/${n_infos} handles resolved to real paths" \
           'the 2020 openzfs#6079 FID report no longer reproduces; Layer 2 is viable'
      note 'Layer 2 stays optional per ADR-0011 — viability is not a reason to grant CAP_SYS_ADMIN'
    fi

    # FAN_RENAME (5.17+) is what lets the indexer treat a move as a move. Without it the design
    # falls back to MOVED_FROM/MOVED_TO cookie matching, which ADR-0011 explicitly refuses.
    if grep -q 'flags=[^ ]*RENAME' "$FAN_OUT"; then
      old_new=$(grep -c 'typename=OLD_DFID_NAME\|typename=NEW_DFID_NAME' "$FAN_OUT" || true)
      pass "FAN_RENAME delivered both endpoints in one event (${old_new} OLD/NEW records)"
    else
      note 'no FAN_RENAME event observed — the indexer would be forced into MOVED_FROM/MOVED_TO cookie matching' \
           "$(grep -c '^EVENT ' "$FAN_OUT" || true) events seen"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '2. Per-superblock scope — does the parent mark see the child dataset?'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0011 §2 says FAN_MARK_FILESYSTEM covers exactly one superblock, and every ZFS dataset is its
# own superblock. If that holds, a per-user-dataset NAS needs a marking control loop and inherits
# a create-to-mark race. If it does not hold, that whole paragraph of the ADR is wrong.

parent_probe=$(probe_stat "$PARENT_PATH")
child_probe=$(probe_stat "$CHILD_PATH")
parent_fsid=$(fp_field "$parent_probe" fsid)
child_fsid=$(fp_field "$child_probe" fsid)
parent_dev=$(fp_field "$parent_probe" dev)
child_dev=$(fp_field "$child_probe" dev)

# coreutils computes the fsid with its own word order; recorded alongside so a human reading the
# evidence can cross-check against the C probe without re-deriving the encoding.
note "stat -f fsid parent=$(stat -f -c '%i' "$PARENT_PATH") child=$(stat -f -c '%i' "$CHILD_PATH")"
note "probe fsid parent=${parent_fsid:-?} child=${child_fsid:-?}"
note "st_dev parent=${parent_dev:-?} child=${child_dev:-?}"

if [ "$HAVE_C" -ne 1 ]; then
  # Fall back to st_dev, which is a weaker but still meaningful separation signal.
  pdev=$(stat -c '%d' "$PARENT_PATH"); cdev=$(stat -c '%d' "$CHILD_PATH")
  assert_ne 'parent and child datasets are distinct devices (st_dev)' "$pdev" "$cdev"
elif [ -z "$parent_fsid" ] || [ -z "$child_fsid" ]; then
  fail 'could not read fsid from either dataset' "parent='$parent_fsid' child='$child_fsid'"
elif [ "$parent_fsid" = "$child_fsid" ]; then
  fail 'parent and child datasets report the SAME fsid' "both = $parent_fsid"
  warn 'Two separately mounted ZFS datasets sharing an f_fsid is a ZFS bug — report upstream.'
  note 'CONSEQUENCE: (fsid, handle) is not a unique key across datasets; ADR-0005 must key on dataset GUID'
else
  pass 'parent and child datasets have DIFFERENT fsids (separate superblocks)' \
       "parent=$parent_fsid child=$child_fsid"
fi

if [ "$HAVE_C" -eq 1 ] && [ "${MARK_ERRNO:-x}" = "0" ]; then
  child_hits=$(grep -c 'name=child-a' "$FAN_OUT" || true)
  parent_hits=$(grep -c 'name=parent-a' "$FAN_OUT" || true)
  note "events naming a parent-dataset file: $parent_hits ; naming a child-dataset file: $child_hits"

  if [ "$parent_hits" -eq 0 ]; then
    fail 'the mark saw no events for its OWN dataset' \
         'the scope test below is meaningless without this baseline'
  elif [ "$child_hits" -gt 0 ]; then
    # Good news for operations, bad news for the ADR — and the ADR is what Phase 1 will be built
    # from, so it has to be loud either way.
    unexpected 'the parent filesystem-wide mark DID see events inside the child dataset' \
               "$child_hits child events — ADR-0011 §2 (one mark = one superblock) is WRONG here"
    note 'If this holds, the per-dataset marking control loop and its create-to-mark race can be dropped'
  else
    pass 'child-dataset events are INVISIBLE to the parent filesystem-wide mark' \
         'per-superblock scope confirmed'
    note 'CONSEQUENCE: ADR-0011 Layer 2 requires a per-dataset marking control loop; the zfs-create-to-mark race is real'
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '3. Handle round trip and stability across zpool export/import (ADR-0005)'
# ═══════════════════════════════════════════════════════════════════════════════
# ADR-0005 leaves this "unverified" and designs around both outcomes. Settle it: if the
# identifier moves across an export/import, every cached (fsid, handle) row is invalid at every
# restart and the physical-identity key must be dataset GUID + inode + generation instead.

STABLE_FILE="$PARENT_PATH/stable.txt"
echo 'depsis-stable' >"$STABLE_FILE"

pool_guid_before=$(zpool get -H -o value guid "$DEPSIS_TEST_POOL")
ds_guid_before=$(zfs get -H -o value guid "$PARENT_DS")
before=$(probe_stat "$STABLE_FILE")
b_ino=$(fp_field "$before" ino)
b_gen=$(fp_field "$before" gen)
b_fsid=$(fp_field "$before" fsid)
b_htype=$(fp_field "$before" htype)
b_handle=$(fp_field "$before" handle)
b_nthrc=$(fp_field "$before" nthrc)
b_ntherrno=$(fp_field "$before" ntherrno)

if [ "$HAVE_C" -eq 1 ]; then
  if [ "${b_nthrc:-1}" = "0" ]; then
    pass 'name_to_handle_at succeeded on a ZFS file' \
         "htype=$b_htype hbytes=$(fp_field "$before" hbytes)"
  else
    fail "name_to_handle_at failed on ZFS, errno=$b_ntherrno" \
         'ADR-0005 physical identity cannot use file handles at all'
  fi
  note "BEFORE export: ino=$b_ino gen=$b_gen fsid=$b_fsid htype=$b_htype handle=$b_handle"
  note "BEFORE export: pool_guid=$pool_guid_before dataset_guid=$ds_guid_before"

  # Round trip while the pool is still imported — proves the handle is decodable at all before
  # we ask whether it survives anything.
  rt=$("$FIDPROBE" open "$PARENT_PATH" "${b_htype:-0}" "${b_handle:--}" 2>/dev/null || true)
  if [ "$(fp_field "$rt" rc)" = "0" ]; then
    assert_eq 'open_by_handle_at round trip returns the same inode' "$b_ino" "$(fp_field "$rt" ino)"
    note "round trip resolved to: $(fp_field "$rt" resolved)"
  else
    fail "open_by_handle_at round trip failed, errno=$(fp_field "$rt" errno)" \
         "msg=$(fp_field "$rt" msg)"
  fi
fi

cd /
assert_cmd 'zpool export succeeds' ok -- zpool export "$DEPSIS_TEST_POOL"
# ADR-0012 claims pool members are found by-id regardless of slot. Importing with an explicit
# by-id search dir is the cheapest possible check of that claim.
assert_cmd 'zpool import -d /dev/disk/by-id finds the pool' ok \
  -- zpool import -d /dev/disk/by-id "$DEPSIS_TEST_POOL"

pool_guid_after=$(zpool get -H -o value guid "$DEPSIS_TEST_POOL")
ds_guid_after=$(zfs get -H -o value guid "$PARENT_DS")
assert_eq 'pool GUID survives export/import' "$pool_guid_before" "$pool_guid_after"
assert_eq 'dataset GUID survives export/import' "$ds_guid_before" "$ds_guid_after"

if [ "$HAVE_C" -eq 1 ]; then
  after=$(probe_stat "$STABLE_FILE")
  a_ino=$(fp_field "$after" ino)
  a_gen=$(fp_field "$after" gen)
  a_fsid=$(fp_field "$after" fsid)
  a_htype=$(fp_field "$after" htype)
  a_handle=$(fp_field "$after" handle)
  note "AFTER import: ino=$a_ino gen=$a_gen fsid=$a_fsid htype=$a_htype handle=$a_handle"

  assert_eq 'inode survives export/import'      "$b_ino"    "$a_ino"
  assert_eq 'generation survives export/import' "$b_gen"    "$a_gen"
  assert_eq 'file handle bytes are byte-identical after export/import' "$b_handle" "$a_handle"

  if [ "$b_fsid" = "$a_fsid" ]; then
    pass 'fsid survives export/import' "= $a_fsid"
    note 'ADR-0005: (fsid, handle) is a usable persistent key; the dataset-GUID fallback is not needed'
  else
    fail 'fsid CHANGED across export/import' "before=$b_fsid after=$a_fsid"
    warn 'Every cached (fsid, handle) row would be invalidated on each restart.'
    note 'ADR-0005 fallback is MANDATORY: key physical identity on dataset GUID + inode + generation'
  fi

  # The strongest form of the question: does an identifier captured before the export still open
  # the same object after the import?
  rt2=$("$FIDPROBE" open "$PARENT_PATH" "${b_htype:-0}" "${b_handle:--}" 2>/dev/null || true)
  if [ "$(fp_field "$rt2" rc)" = "0" ]; then
    assert_eq 'the PRE-export handle still resolves to the same inode after import' \
      "$b_ino" "$(fp_field "$rt2" ino)"
  else
    fail "the pre-export handle no longer resolves, errno=$(fp_field "$rt2" errno)" \
         "msg=$(fp_field "$rt2" msg) — handles are not restart-stable"
  fi
fi

note 'NOT COVERED: stability across a real reboot (only export/import was exercised)'

# ═══════════════════════════════════════════════════════════════════════════════
section '4. Inode reuse and generation (ADR-0005 — the silent authority transfer)'
# ═══════════════════════════════════════════════════════════════════════════════
# Without a working generation, reconciliation step 2 joins on (dataset_id, inode) alone and a
# deleted file's ACL, owner and task links can land on an unrelated new file that inherited its
# inode number. ADR-0005 calls this out explicitly; this section is where it is either proven
# impossible or proven possible.

zfs snapshot "$PARENT_DS@p0d-base"

REUSE_DIR="$PARENT_PATH/reuse"
mkdir -p "$REUSE_DIR"

if [ "$HAVE_C" -ne 1 ]; then
  warn 'no C probe — generation cannot be read, so the whole reuse test is inconclusive'
  note 'ADR-0005 GENERATION UNPROVEN: no way to read i_generation without the C probe'
else
  # 4a. Is generation readable at all? statx has no generation field; if FS_IOC_GETVERSION is
  # unimplemented on ZFS then ADR-0005's physical key cannot be built as specified.
  echo 'gen-a' >"$PARENT_PATH/gen-a"
  echo 'gen-b' >"$PARENT_PATH/gen-b"
  ga=$(probe_stat "$PARENT_PATH/gen-a")
  gb=$(probe_stat "$PARENT_PATH/gen-b")
  ga_rc=$(fp_field "$ga" genrc); ga_gen=$(fp_field "$ga" gen); gb_gen=$(fp_field "$gb" gen)

  if [ "${ga_rc:-1}" = "0" ]; then
    pass 'FS_IOC_GETVERSION returns a generation on ZFS' "gen=$ga_gen"
  else
    fail "FS_IOC_GETVERSION failed on ZFS, errno=$(fp_field "$ga" generrno)" \
         'ADR-0005 depends on ino_generation; without it reconciliation must fall back to the file handle alone'
    warn 'ADR-0005 must be amended: generation is NOT available via ioctl on this ZFS.'
  fi

  # 4b. Granularity. ZFS derives i_generation from the creation txg, so two files created inside
  # one txg can share it. That is not an academic point: delete-then-recreate inside a 5 s txg
  # window is exactly the pattern that would defeat the (inode, generation) key.
  note "two files created back-to-back: gen-a=$ga_gen gen-b=$gb_gen"
  if [ -n "$ga_gen" ] && [ "$ga_gen" = "$gb_gen" ]; then
    note 'generation is COARSE — two files created in the same txg share it' \
         'reconciliation must treat (inode, generation) as weak when delete and replacement land in one txg'
    warn 'Generation is txg-granular, not per-file. Record this in ADR-0005.'
  else
    note 'generation differed between two back-to-back creations (finer than one txg here)'
  fi

  # 4c. The victim: record its identity, delete it, and force a txg boundary so that any reuse
  # necessarily happens in a later txg.
  VICTIM="$REUSE_DIR/victim"
  echo 'victim' >"$VICTIM"
  v=$(probe_stat "$VICTIM")
  v_ino=$(fp_field "$v" ino); v_gen=$(fp_field "$v" gen)
  v_htype=$(fp_field "$v" htype); v_handle=$(fp_field "$v" handle)
  note "victim: ino=$v_ino gen=$v_gen handle=$v_handle"

  rm -f "$VICTIM"
  sync
  sleep 6   # default zfs_txg_timeout is 5 s; cross it so a reused dnode gets a new creation txg

  # The handle-based check does not depend on winning the reuse lottery: a handle carries the
  # generation, so a stale handle must fail even if the inode number is handed to someone else.
  st=$("$FIDPROBE" open "$PARENT_PATH" "${v_htype:-0}" "${v_handle:--}" 2>/dev/null || true)
  st_rc=$(fp_field "$st" rc); st_errno=$(fp_field "$st" errno)
  if [ "$st_rc" = "0" ]; then
    unexpected 'the deleted file’s handle still opens something' \
               "resolved=$(fp_field "$st" resolved) ino=$(fp_field "$st" ino)"
    warn 'A stale handle that resolves is a direct path to applying a dead file’s ACL to a live one.'
  elif [ "$st_errno" = "116" ]; then
    pass 'the deleted file’s handle now returns ESTALE(116)' \
         'ADR-0011 is right that ESTALE is routine and means "drop from the index"'
  else
    pass "the deleted file’s handle no longer opens (errno=$st_errno)" \
         "msg=$(fp_field "$st" msg) — expected ESTALE(116), got something else; worth noting"
    note "stale-handle errno was $st_errno, not ESTALE(116) — parser must not special-case 116 alone"
  fi

  # 4d. Force reuse: create many files and look for one that inherited the victim's inode.
  info "creating $REUSE_N files to force dnode reuse (this takes a moment)"
  i=0
  while [ "$i" -lt "$REUSE_N" ]; do
    : >"$REUSE_DIR/f$i"
    i=$((i + 1))
  done
  sync
  find "$REUSE_DIR" -maxdepth 1 -type f -printf '%i %f\n' >/tmp/p0d-inos.txt
  hit=$(grep -m1 "^$v_ino " /tmp/p0d-inos.txt || true)

  if [ -z "$hit" ]; then
    # Not a pass. The mechanism was never exercised, and saying otherwise would be the exact
    # "quietly passes" failure this harness exists to prevent.
    note "INCONCLUSIVE: inode $v_ino was not reused within $REUSE_N creations" \
         'the (inode, generation) discrimination path was not exercised in this run'
    warn "Inode reuse did not occur with $REUSE_N files — this test proved nothing about generation."
  else
    reuser="$REUSE_DIR/${hit#* }"
    r=$(probe_stat "$reuser")
    r_ino=$(fp_field "$r" ino); r_gen=$(fp_field "$r" gen); r_handle=$(fp_field "$r" handle)
    note "inode $v_ino was REUSED by $reuser: gen=$r_gen handle=$r_handle"
    assert_eq 'the reusing file really has the victim inode number' "$v_ino" "$r_ino"

    if [ -n "$v_gen" ] && [ "$v_gen" = "$r_gen" ]; then
      fail 'the reused inode carries the SAME generation as the deleted file' \
           "ino=$v_ino gen=$v_gen — (dataset_id, inode, generation) does NOT discriminate"
      warn 'ADR-0005 is wrong: generation cannot prevent a dead file’s ACL landing on a new file.'
    else
      pass 'the reused inode carries a DIFFERENT generation' "old=$v_gen new=$r_gen"
      note 'ADR-0005 reconciliation step 2 is safe: (dataset_id, inode, generation) discriminates'
    fi
    assert_ne 'the reusing file has a different file handle than the deleted one' \
      "$v_handle" "$r_handle"

    # And the deleted file's handle must still not open the new occupant of that inode.
    st2=$("$FIDPROBE" open "$PARENT_PATH" "${v_htype:-0}" "${v_handle:--}" 2>/dev/null || true)
    if [ "$(fp_field "$st2" rc)" = "0" ]; then
      unexpected 'the deleted file’s handle opened the file that reused its inode' \
                 "resolved=$(fp_field "$st2" resolved) — silent authority transfer is reachable"
    else
      pass 'the deleted file’s handle still refuses to open the inode’s new occupant' \
           "errno=$(fp_field "$st2" errno)"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '5. Samba vfs_full_audit — ADR-0011 Layer 1, the PRIMARY source'
# ═══════════════════════════════════════════════════════════════════════════════
# This is the layer the §18.2 acceptance criterion actually depends on. It has to work with zero
# kernel capability, and its line format has to be parseable, or the whole inversion in ADR-0011
# was a mistake.

if ! command -v smbclient >/dev/null 2>&1 || ! command -v smbd >/dev/null 2>&1; then
  warn 'samba/smbclient not installed — Layer 1 is entirely unproven'
  note 'ADR-0011 LAYER 1 SKIPPED — P0-D is NOT complete without it'
else
  cp /etc/samba/smb.conf /etc/samba/smb.conf.p0d-backup

  # The audit stanza is copied verbatim from ADR-0011 §Katman 1. Deviating from it here would
  # mean testing a configuration that will never ship.
  cat >/etc/samba/smb.conf <<EOF
[global]
    workgroup = WORKGROUP
    server min protocol = SMB3
    security = user
    map to guest = never
    vfs objects = acl_xattr full_audit
    full_audit:prefix = %u|%I|%S
    # No 'rmdir': it is not a valid opname in Samba 4.22 (directory removal goes through
    # unlinkat since the *at() VFS switch), and an invalid entry makes vfs_full_audit refuse
    # every connection rather than just skipping the op. testparm does not catch it. Measured
    # in P0-B; see ADR-0011.
    full_audit:success = create_file renameat unlinkat mkdirat close ftruncate linkat symlinkat
    full_audit:failure = none
    full_audit:facility = local5
    full_audit:priority = notice

[$SMB_SHARE]
    path = $SHARE_PATH
    read only = no
    inherit acls = yes
    valid users = $TEST_USER
EOF

  assert_cmd 'testparm accepts the ADR-0011 audit config' ok -- testparm -s --suppress-prompt

  chown "$TEST_USER":"$TEST_USER" "$SHARE_PATH"
  chmod 0750 "$SHARE_PATH"
  printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | smbpasswd -s -a "$TEST_USER" >/dev/null
  smbpasswd -e "$TEST_USER" >/dev/null
  systemctl restart smbd
  sleep 2

  echo 'p0d payload' >/tmp/p0d-payload.txt

  # A file created out-of-band so its pre-rename identity can be captured; ADR-0005 step 2
  # depends on the physical key surviving an SMB rename.
  echo 'keep-my-id' >"$SHARE_PATH/idkeep.txt"
  chown "$TEST_USER":"$TEST_USER" "$SHARE_PATH/idkeep.txt"
  idk_before=$(probe_stat "$SHARE_PATH/idkeep.txt")

  AUDIT_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
  sleep 1

  smb() { smbclient "//127.0.0.1/$SMB_SHARE" -U "$TEST_USER%$SMB_PASS" -c "$1" 2>&1; }

  smb_out=$(smb 'put /tmp/p0d-payload.txt audit1.txt' || true)
  note "smbclient put: ${smb_out//$'\n'/ ; }"
  smb 'rename audit1.txt audit2.txt' >/dev/null 2>&1 || true
  smb 'rename idkeep.txt idkeep-renamed.txt' >/dev/null 2>&1 || true
  smb 'del audit2.txt' >/dev/null 2>&1 || true
  # ADR-0011 names this the common index-corrupter: Explorer writes a temp file, closes it, then
  # renames it over the real name. The close the indexer keys on names a file that no longer exists.
  smb 'put /tmp/p0d-payload.txt tmp.partial; rename tmp.partial final.txt' >/dev/null 2>&1 || true

  sleep 2

  AUDIT_RAW=/tmp/p0d-audit-raw.log
  AUDIT_MSG=/tmp/p0d-audit-msg.log
  : >"$AUDIT_RAW"; : >"$AUDIT_MSG"
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -t smbd_audit --since "$AUDIT_SINCE" --no-pager -o short >"$AUDIT_RAW" 2>/dev/null || true
    journalctl -t smbd_audit --since "$AUDIT_SINCE" --no-pager -o cat  >"$AUDIT_MSG" 2>/dev/null || true
  fi
  transport=journald
  if [ ! -s "$AUDIT_MSG" ]; then
    # ADR-0011's transport claim is "local5 -> rsyslog -> daemon". If journald did not receive
    # the lines, where they actually landed is itself the finding.
    grep -h 'smbd_audit' /var/log/syslog /var/log/messages /var/log/samba/log.* \
      >"$AUDIT_RAW" 2>/dev/null || true
    cp "$AUDIT_RAW" "$AUDIT_MSG" 2>/dev/null || true
    transport=logfile
  fi
  note "audit transport that actually delivered: $transport"

  if [ ! -s "$AUDIT_MSG" ]; then
    fail 'no smbd_audit lines were produced by any transport' \
         'ADR-0011 Layer 1 does not work as configured — the PRIMARY event source is missing'
    warn 'The §18.2 SLA path is broken. Nothing else in ADR-0011 compensates for this.'
  else
    note "first audit line as rendered: $(head -1 "$AUDIT_RAW")"
    raw_all=$(cat "$AUDIT_RAW"); msg_all=$(cat "$AUDIT_MSG")

    assert_contains 'the syslog identifier is smbd_audit' 'smbd_audit' "$raw_all"
    assert_contains 'audit lines carry the %u|%I|%S prefix' \
      "$TEST_USER|127.0.0.1|$SMB_SHARE|" "$msg_all"
    assert_contains 'create_file is audited'    "|create_file|ok|" "$msg_all"
    assert_contains 'close is audited'          "|close|ok|"       "$msg_all"
    assert_contains 'renameat is audited'       "|renameat|ok|"    "$msg_all"
    assert_contains 'unlinkat is audited'       "|unlinkat|ok|"    "$msg_all"

    # ADR-0011 forbids write/read/open in the success list precisely because they fire per
    # syscall. If they show up anyway, the machine will drown under load.
    for op in write pwrite read pread open getattr lstat; do
      if grep -q "|$op|ok|" "$AUDIT_MSG"; then
        fail "per-syscall operation '$op' is being audited despite not being listed" \
             'ADR-0011 forbids this — it floods the transport'
      fi
    done

    # ADR-0011 picks close as THE content-changed trigger on the claim that it is one event per
    # file. If it is not, the indexer needs a dedupe window and the ADR must say so.
    close_n=$(grep -c '|close|ok|.*audit1\.txt' "$AUDIT_MSG" || true)
    note "close events for audit1.txt: $close_n"
    if [ "$close_n" -eq 1 ]; then
      pass 'close fired exactly once for the uploaded file'
    elif [ "$close_n" -eq 0 ]; then
      fail 'no close event for the uploaded file' \
           'the ADR-0011 content-changed trigger never fires — indexing would never be triggered'
    else
      fail "close fired $close_n times for one uploaded file" \
           'the indexer MUST dedupe on (share, path) within a window; ADR-0011 must record this'
    fi

    # renameat must carry both endpoints on one line, otherwise the parser cannot tell a move
    # from delete+create and ADR-0005 loses the file id.
    ren_line=$(grep -m1 '|renameat|ok|.*audit1\.txt' "$AUDIT_MSG" || true)
    note "renameat line: ${ren_line:-<none>}"
    if [ -n "$ren_line" ]; then
      if grep -q 'audit1\.txt' <<<"$ren_line" && grep -q 'audit2\.txt' <<<"$ren_line"; then
        pass 'renameat reports BOTH the old and the new name on one line' \
             'the parser can emit a move instead of delete+create'
      else
        fail 'renameat line does not carry both names' "$ren_line"
      fi
    else
      fail 'no renameat line for the rename that was performed'
    fi

    # The Windows Explorer atomic-save pattern.
    part_close=$(grep -c '|close|ok|.*tmp\.partial' "$AUDIT_MSG" || true)
    final_close=$(grep -c '|close|ok|.*final\.txt' "$AUDIT_MSG" || true)
    part_ren=$(grep -m1 '|renameat|ok|.*tmp\.partial' "$AUDIT_MSG" || true)
    note "atomic-save pattern: close(tmp.partial)=$part_close close(final.txt)=$final_close"
    note "atomic-save rename line: ${part_ren:-<none>}"
    if [ "$final_close" -eq 0 ] && [ "$part_close" -gt 0 ]; then
      note 'CONFIRMED index-corrupter: the only close names tmp.partial, which no longer exists' \
           'the indexer must carry the close forward through the renameat, not index on close alone'
      warn 'ADR-0011 must state: a renameat whose source had a prior close IS a content event.'
    elif [ "$final_close" -gt 0 ]; then
      note 'a close was also recorded for final.txt — indexing on close alone would still work here'
    else
      note 'the atomic-save pattern produced no close at all; recorded for the parser spec'
    fi

    # ADR-0005 annex item 1, filesystem half: does the physical join key survive an SMB rename?
    if [ "$HAVE_C" -eq 1 ] && [ -e "$SHARE_PATH/idkeep-renamed.txt" ]; then
      idk_after=$(probe_stat "$SHARE_PATH/idkeep-renamed.txt")
      assert_eq 'inode survives an SMB rename' \
        "$(fp_field "$idk_before" ino)" "$(fp_field "$idk_after" ino)"
      assert_eq 'generation survives an SMB rename' \
        "$(fp_field "$idk_before" gen)" "$(fp_field "$idk_after" gen)"
      assert_eq 'the file handle survives an SMB rename' \
        "$(fp_field "$idk_before" handle)" "$(fp_field "$idk_after" handle)"
      note 'ADR-0005 reconciliation step 2 can therefore recover the same id after an SMB rename'
    else
      note 'SMB rename identity check skipped (no C probe, or the rename did not land)'
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
section '6. zfs diff — ADR-0011 Layer 3 reconciliation'
# ═══════════════════════════════════════════════════════════════════════════════

# Ordering matters and an earlier version of this test got it wrong.
#
# For zfs diff to emit an R line, the file must exist in BOTH snapshots under different names.
# The first version created tobe-renamed.txt AFTER the base snapshot and then renamed it, so
# the file never existed in the base at all — ZFS correctly reported '+' at the final name, and
# the test concluded "zfs diff cannot report renames", which is false and would have pushed
# ADR-0011 Layer 3 into a redesign it does not need.
#
# So: populate FIRST, snapshot, then mutate.
DIFF_DIR="$PARENT_PATH/diff"
mkdir -p "$DIFF_DIR"
echo 'keep'    >"$DIFF_DIR/keep.txt"
echo 'move-me' >"$DIFF_DIR/tobe-renamed.txt"
echo 'kill-me' >"$DIFF_DIR/tobe-deleted.txt"
sync

zfs snapshot "$PARENT_DS@p0d-a"

mv "$DIFF_DIR/tobe-renamed.txt" "$DIFF_DIR/renamed.txt"
rm -f "$DIFF_DIR/tobe-deleted.txt"
echo 'more' >>"$DIFF_DIR/keep.txt"
echo 'brand new' >"$DIFF_DIR/new.txt"
sync

zfs snapshot "$PARENT_DS@p0d-b"

file_count=$(find "$PARENT_PATH" -xdev -type f 2>/dev/null | wc -l)
note "dataset holds ~$file_count files (xdev, excludes the child dataset)"

diff_rc=0
t0=$(date +%s%N)
diff_out=$(zfs diff -H -F -t "$PARENT_DS@p0d-a" "$PARENT_DS@p0d-b" 2>/tmp/p0d-diff.err) || diff_rc=$?
t1=$(date +%s%N)
small_ms=$(( (t1 - t0) / 1000000 ))

if [ "$diff_rc" -ne 0 ]; then
  fail "zfs diff failed (rc=$diff_rc)" "$(head -5 /tmp/p0d-diff.err 2>/dev/null)"
else
  pass 'zfs diff between two snapshots succeeded'
  note "diff output:" "${diff_out//$'\n'/ ; }"

  # The one capability inotify structurally cannot provide, and the reason ADR-0011 dropped
  # inotify outright: a rename reported as one row carrying both endpoints.
  r_line=$(awk -F'\t' '$2=="R"{print; exit}' <<<"$diff_out")
  if [ -z "$r_line" ]; then
    fail 'zfs diff produced no R (rename) line for a rename that definitely happened' \
         "$(head -20 <<<"$diff_out")"
    warn 'Layer 3 cannot reconcile renames — ADR-0005 would lose the file id on every SMB move.'
  else
    r_nf=$(awk -F'\t' '$2=="R"{print NF; exit}' <<<"$diff_out")
    note "R line ($r_nf tab-separated fields): $r_line"
    if [ "${r_nf:-0}" -ge 5 ] \
       && grep -q 'tobe-renamed\.txt' <<<"$r_line" \
       && grep -q 'renamed\.txt' <<<"$r_line"; then
      pass 'the R line carries BOTH the old and the new path' \
           'renames reconcile correctly; this is what inotify cannot do'
    else
      fail 'the R line does not carry both paths as expected' "nf=$r_nf line=$r_line"
    fi
  fi
fi

# Two honest numbers: a small delta (the steady-state case at a 15 min interval) and a bulk delta
# (the post-migration / post-receive case). Neither is a cold-ARC number.
sync
echo 3 >/proc/sys/vm/drop_caches 2>/dev/null || true
t0=$(date +%s%N)
zfs diff -H -F -t "$PARENT_DS@p0d-base" "$PARENT_DS@p0d-b" >/dev/null 2>&1 || true
t1=$(date +%s%N)
bulk_ms=$(( (t1 - t0) / 1000000 ))

note "zfs diff timing: small delta = ${small_ms} ms; ~${REUSE_N}-object delta = ${bulk_ms} ms" \
     "dataset ~$file_count files, on Hyper-V VHDX vdevs"
note 'These are WARM-ARC numbers: drop_caches does not evict the ZFS ARC, and ADR-0012 forbids' \
     'presenting VM figures as hardware figures. ADR-0011 item 7 (1M files, cold cache) is still open.'
if [ "$bulk_ms" -gt 900000 ]; then
  warn "A ${bulk_ms} ms diff approaches ADR-0011's 15-minute reconciliation interval."
fi

# ─── delegation split ─────────────────────────────────────────────────────────
# ADR-0011 §Katman 3 predicts a precise split: diff can be delegated, snapshot cannot, because
# snapshot needs mount and mount is not delegable on Linux. If snapshot turns out to be
# delegable, Layer 3 does not need a root unit at all — a materially better design.
note "/dev/zfs mode (delegation depends on it): $(stat -c '%a %U:%G' /dev/zfs 2>/dev/null || echo '?')"

assert_cmd 'unprivileged zfs diff is refused BEFORE delegation' fail \
  -- runuser -u "$TEST_USER" -- zfs diff -H "$PARENT_DS@p0d-a" "$PARENT_DS@p0d-b"

zfs allow -u "$TEST_USER" diff,snapshot "$PARENT_DS"
note "zfs allow now reads: $(zfs allow "$PARENT_DS" 2>&1 | tr '\n' ';')"

assert_cmd 'delegated user CAN run zfs diff' ok \
  -- runuser -u "$TEST_USER" -- zfs diff -H "$PARENT_DS@p0d-a" "$PARENT_DS@p0d-b"

# This was written expecting FAILURE, on ADR-0011's claim that snapshot needs a delegated
# mount and that mount is not delegable on Linux. It SUCCEEDED, and the follow-up probe showed
# it succeeds even without `mount` in the delegation set. The ADR was wrong and has been
# corrected: Layer 3 runs unprivileged, with no root timer unit.
#
# So the assertion is inverted to match reality, and the thing now worth guarding is that the
# delegation actually works — because if a future ZFS release tightens this, Layer 3 silently
# stops taking snapshots and reconciliation quietly stops happening.
assert_cmd 'delegated user CAN zfs snapshot — no root unit needed (ADR-0011 corrected)' ok \
  -- runuser -u "$TEST_USER" -- zfs snapshot "$PARENT_DS@p0d-unpriv"

# Delegation reaching a non-root user depends on /dev/zfs being world-accessible. Record it:
# it is the price of an unprivileged Layer 3 and belongs in the threat model, not in a comment.
note "/dev/zfs mode: $(stat -c '%a %U:%G' /dev/zfs) — delegation to a non-root user depends on this"

poc_summary

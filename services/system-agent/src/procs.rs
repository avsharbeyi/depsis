//! Süreç listesi ve tekil kapatma — görev yöneticisinin ajan yarısı.
//!
//! Sahibin istediği şey bir masaüstünün görev yöneticisi: arka planda ne koşuyor, ve sistemden
//! olmayanı kapatabileyim. "Sistemden olmayan"ın tanımı BURADA, tek yerde: hem listede
//! `protected` bayrağı hem kapatmanın reddi aynı fonksiyondan çıkar — arayüzün düğme
//! gösterdiğine ajanın "hayır" demesi (ya da tersi) bir tutarsızlık sınıfıdır ve iki kopya
//! kuralın kaderidir.
//!
//! ── neden /proc, neden `ps` değil ──
//!
//! `ps`'in çıktısı yerele ve sürüme göre oynar ve bir argv daha demektir; /proc ise çekirdeğin
//! kendi sözü. Okunan üç dosya da (`comm`, `cmdline`, `status`) süreç kaybolurken ENOENT verir —
//! bu bir hata değil, listenin doğası: süreçler biz okurken de doğar ve ölür.
//!
//! ── kapatmanın TOCTOU'su: pid yeniden kullanımı ──
//!
//! Bir pid, süreci öldükten sonra BAŞKA bir sürece verilebilir. Listeyi dün açmış bir ekrandan
//! gelen "pid 4242'yi kapat", bugün bambaşka bir şeyi vurabilir. Bu yüzden kapatma çağrısı pid
//! ile birlikte KOMUT ADINI da taşır ve ajan sinyalden hemen önce `/proc/<pid>/comm`'u yeniden
//! okuyup karşılaştırır — havuz sihirbazının WWN yeniden doğrulamasıyla aynı kalıp, aynı
//! gerekçe.

use std::path::Path;

/// Bir satırın taşıdığı her şey. `protected`, kapatmanın aynı kuraldan reddedileceğinin sözü.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub uid: u32,
    /// /etc/passwd'den; çözülemezse uid'in kendisi yazılır. Görsel bir kolaylık, yetki verisi
    /// değil — yetki kararları uid üzerinden.
    pub user: String,
    pub comm: String,
    /// Boşlukla ayrılmış argv, 200 bayta kırpılmış: liste okunmak için, adli kopya değil.
    pub args: String,
    pub rss_bytes: u64,
    pub protected: bool,
}

/// Listenin tavanı. Bir masaüstü kutusunda birkaç yüz süreç olağan; dört yüzü aşan bir liste
/// zaten okunmuyor, ve sınırsız bir yanıt kontrol soketinde sınırsız bir gövde demek.
pub const MAX_PROCESSES: usize = 400;

/// Adı bu listede geçen süreç, sahibi kim olursa olsun SİSTEMDİR ve kapatılamaz.
///
/// Liste bilerek kısa ve bilerek ada dayalı: uid==0 kuralı zaten root'un her şeyini koruyor;
/// burası root OLMAYAN hesaplarda koşan ama cihazın kendisi olan şeyler için — postgres kendi
/// hesabında, DEPSIS'in API'si depsis-api'de, podman depsis-apps'te koşar ve üçü de "arka plan
/// hizmeti" diye kapatıldığında cihaz ölür.
const PROTECTED_COMMS: &[&str] = &[
    "systemd",
    "systemd-journal",
    "systemd-logind",
    "systemd-udevd",
    "systemd-timesyn",
    "dbus-daemon",
    "sshd",
    "sshd-session",
    "postgres",
    "nginx",
    "node",
    "depsis-agent",
    "depsis-console",
    "zerotier-one",
    "podman",
    "conmon",
    "agetty",
    "login",
    "cron",
];

fn is_protected(uid: u32, comm: &str) -> bool {
    // uid 0 MUTLAK: root'un süreçleri arasında "zararsız" ayıklamaya çalışan bir liste, ilk
    // unutulan girdide cihazı kapatan listedir. Kalanı ada göre.
    uid == 0 || PROTECTED_COMMS.contains(&comm)
}

/// /etc/passwd'den uid → ad. Bir kez okunur, çağıran haritayı taşır.
fn user_names(passwd: &str) -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    for line in passwd.lines() {
        let mut parts = line.split(':');
        let (Some(name), _, Some(uid)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let Ok(uid) = uid.parse::<u32>() {
            map.insert(uid, name.to_string());
        }
    }
    map
}

/// `proc_root` altındaki süreçleri oku. Gerçekte `/proc`; testlerde sahte bir ağaç.
///
/// Çekirdek iş parçacıkları (boş `cmdline`) listede YOK: kapatılamazlar, kullanıcının
/// "arka plan hizmeti" sorusunun cevabı değiller, ve elli tanesi gerçek listeyi gömer.
pub fn snapshot(proc_root: &Path, passwd: &str) -> (Vec<ProcessInfo>, bool) {
    let names = user_names(passwd);
    let mut out = Vec::new();
    let mut truncated = false;

    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return (out, false);
    };
    let mut pids: Vec<u32> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .collect();
    pids.sort_unstable();

    for pid in pids {
        if out.len() >= MAX_PROCESSES {
            truncated = true;
            break;
        }
        let dir = proc_root.join(pid.to_string());
        // Sıra önemli değil; hepsi ENOENT verebilir ve veren süreç yok sayılır.
        let Ok(cmdline) = std::fs::read(dir.join("cmdline")) else {
            continue;
        };
        if cmdline.is_empty() {
            continue; // çekirdek iş parçacığı
        }
        let Ok(comm) = std::fs::read_to_string(dir.join("comm")) else {
            continue;
        };
        let comm = comm.trim().to_string();
        let Ok(status) = std::fs::read_to_string(dir.join("status")) else {
            continue;
        };
        let uid = status
            .lines()
            .find_map(|l| l.strip_prefix("Uid:"))
            .and_then(|l| l.split_whitespace().next())
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        let rss_kb = status
            .lines()
            .find_map(|l| l.strip_prefix("VmRSS:"))
            .and_then(|l| l.split_whitespace().next())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        let mut args: String = cmdline
            .split(|b| *b == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if args.len() > 200 {
            args.truncate(200);
            args.push('…');
        }

        out.push(ProcessInfo {
            pid,
            uid,
            user: names.get(&uid).cloned().unwrap_or_else(|| uid.to_string()),
            protected: is_protected(uid, &comm),
            comm,
            args,
            rss_bytes: rss_kb * 1024,
        });
    }
    (out, truncated)
}

/// Kapatma kararı: sinyal GÖNDERİLMEDEN önce, taze /proc okumasıyla.
///
/// `Ok(())` yalnız "sinyali göndermek meşru" demek; göndermek çağıranın işi. Karar ile eylemin
/// ayrılması testin tamamını gerçek süreç öldürmeden yazılabilir kılıyor.
pub fn check_kill(proc_root: &Path, pid: u32, expected_comm: &str) -> Result<(), String> {
    if pid <= 1 {
        return Err("pid 1 sistemin kendisidir".to_string());
    }
    let dir = proc_root.join(pid.to_string());
    let Ok(comm) = std::fs::read_to_string(dir.join("comm")) else {
        return Err(format!("pid {pid} yok — süreç zaten bitmiş olabilir"));
    };
    let comm = comm.trim();
    // PID YENİDEN KULLANIMI: listeyi açan ekran ile düğmeye basılan an arasında pid başka bir
    // sürece geçmiş olabilir. Ad tutmuyorsa bu, kullanıcının kapatmak istediği süreç DEĞİL.
    if comm != expected_comm {
        return Err(format!(
            "pid {pid} artık '{comm}' — kapatılmak istenen '{expected_comm}' değil; liste bayat"
        ));
    }
    let Ok(status) = std::fs::read_to_string(dir.join("status")) else {
        return Err(format!("pid {pid} yok — süreç zaten bitmiş olabilir"));
    };
    let uid = status
        .lines()
        .find_map(|l| l.strip_prefix("Uid:"))
        .and_then(|l| l.split_whitespace().next())
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    if is_protected(uid, comm) {
        return Err(format!(
            "'{comm}' bir sistem süreci; bu panelden kapatılamaz"
        ));
    }
    let Ok(cmdline) = std::fs::read(dir.join("cmdline")) else {
        return Err(format!("pid {pid} yok — süreç zaten bitmiş olabilir"));
    };
    if cmdline.is_empty() {
        return Err(format!("pid {pid} bir çekirdek iş parçacığı"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_proc(dir: &Path, pid: u32, comm: &str, cmdline: &[u8], uid: u32, rss_kb: u64) {
        let p = dir.join(pid.to_string());
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("comm"), format!("{comm}\n")).unwrap();
        std::fs::write(p.join("cmdline"), cmdline).unwrap();
        std::fs::write(
            p.join("status"),
            format!("Name:\t{comm}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\nVmRSS:\t{rss_kb} kB\n"),
        )
        .unwrap();
    }

    const PASSWD: &str = "root:x:0:0::/root:/bin/sh\nayse:x:1000:1000::/home/ayse:/bin/sh\n";

    #[test]
    fn lists_user_processes_and_flags_the_protected_ones() {
        let tmp = tempfile::tempdir().unwrap();
        fake_proc(tmp.path(), 100, "python3", b"python3\0bot.py\0", 1000, 2048);
        fake_proc(tmp.path(), 101, "postgres", b"postgres\0", 105, 4096);
        fake_proc(tmp.path(), 102, "rootjob", b"rootjob\0", 0, 100);
        // çekirdek iş parçacığı: boş cmdline — listede olmamalı
        fake_proc(tmp.path(), 103, "kworker/0:1", b"", 0, 0);

        let (list, truncated) = snapshot(tmp.path(), PASSWD);
        assert!(!truncated);
        let pids: Vec<u32> = list.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![100, 101, 102]);

        let py = list.iter().find(|p| p.pid == 100).unwrap();
        assert!(!py.protected);
        assert_eq!(py.user, "ayse");
        assert_eq!(py.rss_bytes, 2048 * 1024);
        assert_eq!(py.args, "python3 bot.py");

        // postgres kendi hesabında ama adıyla korunuyor; root'unki uid'iyle.
        assert!(list.iter().find(|p| p.pid == 101).unwrap().protected);
        assert!(list.iter().find(|p| p.pid == 102).unwrap().protected);
    }

    #[test]
    fn kill_refuses_the_protected_the_stale_and_the_reused() {
        let tmp = tempfile::tempdir().unwrap();
        fake_proc(tmp.path(), 200, "python3", b"python3\0", 1000, 10);
        fake_proc(tmp.path(), 201, "postgres", b"postgres\0", 105, 10);
        fake_proc(tmp.path(), 202, "rootjob", b"rootjob\0", 0, 10);

        assert!(check_kill(tmp.path(), 200, "python3").is_ok());
        // pid yeniden kullanımı: ad tutmuyor → ret, listenin bayat olduğu söylenerek.
        assert!(check_kill(tmp.path(), 200, "eskiprog")
            .unwrap_err()
            .contains("bayat"));
        assert!(check_kill(tmp.path(), 201, "postgres")
            .unwrap_err()
            .contains("sistem süreci"));
        assert!(check_kill(tmp.path(), 202, "rootjob")
            .unwrap_err()
            .contains("sistem süreci"));
        assert!(check_kill(tmp.path(), 1, "systemd")
            .unwrap_err()
            .contains("pid 1"));
        assert!(check_kill(tmp.path(), 999, "hayalet")
            .unwrap_err()
            .contains("bitmiş olabilir"));
    }
}

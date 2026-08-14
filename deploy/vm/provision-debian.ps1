#Requires -Version 5.1
<#
.SYNOPSIS
    Creates the DEPSIS Debian 13 (trixie) test VM on Hyper-V, unattended.

.DESCRIPTION
    Builds a Generation 2 Hyper-V VM suitable for exercising ZFS, Samba, PostgreSQL and the
    DEPSIS system agent. Every decision here is recorded in docs/adr/0012-dev-test-environment.md
    and the facts behind them in docs/adr/0000-version-baseline.md.

    Facts this script is built on (verified 2026-08-14, see ADR-0000):
      * Debian publishes NO .vhd / .vhdx for any cloud variant. Only .qcow2 / .raw / .tar.xz.
        We therefore download the .raw and block-copy it into a VHDX we create ourselves.
      * Convert-VHD only converts VHD <-> VHDX. It cannot read raw or qcow2. Hence Mount-VHD +
        raw write to \\.\PhysicalDriveN, which needs no third-party tooling.
      * The 'generic' variant is required, NOT 'genericcloud' (which drops the physical-hardware
        drivers Hyper-V Gen2 needs to find root) and NOT 'nocloud' (no cloud-init at all).
      * PowerShell Direct is Windows-guest only. Host->guest control is SSH over a dedicated
        Internal switch with a static IP, because the Default Switch re-randomises its subnet
        on every host boot.
      * A VHDX's page-0x83 disk identifier lives INSIDE the file, so copying a VHDX duplicates it.
        Each ZFS vdev therefore gets its own New-VHD call, and we record the expected identifiers
        so the guest-side PoC can assert on them.
      * Hyper-V mishandles SCSI INQUIRY page 0x80, so there is NO usable disk serial number in the
        guest. DEPSIS must never key disk identity on 'serial'. See ADR-0012.

.PARAMETER Force
    Delete and recreate the VM if it already exists. DESTRUCTIVE - removes all its virtual disks.

.EXAMPLE
    # Must be run from an ELEVATED PowerShell (Hyper-V cmdlets require it unless the user is a
    # member of the 'Hyper-V Administrators' group, SID S-1-5-32-578).
    .\deploy\vm\provision-debian.ps1
#>
[CmdletBinding()]
param(
    [string] $VMName       = 'depsis-poc',
    # Left empty on purpose: $PSScriptRoot is not reliably populated while parameter defaults
    # are being bound (it comes back empty under `powershell -File ...`), so the default is
    # resolved in the body instead. See "resolve paths" below.
    [string] $ArtifactRoot = '',

    # Pin the DATED build directory, never 'latest/', so the environment is reproducible.
    # Verified present 2026-08-14: https://cdimage.debian.org/images/cloud/trixie/
    [string] $DebianBuild  = '20260810-2566',
    [string] $ImageVariant = 'generic',

    [int]    $MemoryGB     = 6,
    [int]    $CpuCount     = 4,
    [int]    $SystemDiskGB = 40,
    [int]    $VdevCount    = 4,
    [int]    $VdevSizeGB   = 20,

    [string] $LabSwitch    = 'DEPSIS-Lab',
    [string] $LabHostIP    = '192.168.244.1',
    [string] $LabGuestIP   = '192.168.244.10',
    [int]    $LabPrefix    = 24,

    # Deterministic MACs so cloud-init network-config can match on them.
    [string] $WanMac       = '00155D0DE909',
    [string] $LabMac       = '00155D0DE90A',

    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ─── resolve paths ────────────────────────────────────────────────────────────
# $PSScriptRoot is empty during parameter binding under `powershell -File`, so the script
# directory is resolved here, with $MyInvocation as a fallback for the odd invocation modes
# (dot-sourcing, ISE) where $PSScriptRoot is also unset.
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    throw 'Could not determine the script directory. Pass -ArtifactRoot explicitly.'
}
if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $ArtifactRoot = Join-Path $scriptDir 'artifacts'
}

# ─── helpers ──────────────────────────────────────────────────────────────────
$script:step = 0
function Step  ($m) { $script:step++; Write-Host ("`n[{0}] {1}" -f $script:step, $m) -ForegroundColor Cyan }
function Info  ($m) { Write-Host "    $m" -ForegroundColor Gray }
function Good  ($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn2 ($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Die   ($m) { Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

function Format-Mac ([string] $m) {
    $clean = ($m -replace '[^0-9A-Fa-f]', '').ToUpper()
    $pairs = for ($i = 0; $i -lt $clean.Length; $i += 2) { $clean.Substring($i, 2) }
    $pairs -join ':'
}

# ─── 0. preflight ─────────────────────────────────────────────────────────────
Step 'Preflight'

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die @'
This script needs elevation.

Either re-run it from an elevated PowerShell ("Run as Administrator"), or grant your
account standing Hyper-V rights once and sign out/in:

    Add-LocalGroupMember -SID 'S-1-5-32-578' -Member $env:USERNAME

(S-1-5-32-578 is the well-known "Hyper-V Administrators" group. On this Turkish-language
Windows it is displayed as "Hyper-V Yoneticileri". It exists but is currently empty.)
'@
}
Good 'Running elevated.'

if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
    Die 'The Hyper-V PowerShell module is not available. Enable the Hyper-V feature first.'
}
if ((Get-Service vmms -ErrorAction SilentlyContinue).Status -ne 'Running') {
    Die 'The Hyper-V Virtual Machine Management service (vmms) is not running.'
}
Good 'Hyper-V present and running.'

foreach ($t in @('curl.exe', 'tar.exe')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Die "$t not found (expected in-box on Windows 11)." }
}

$existing = Get-VM -Name $VMName -ErrorAction SilentlyContinue
if ($existing) {
    if (-not $Force) {
        Die "VM '$VMName' already exists. Re-run with -Force to delete and recreate it (this destroys its disks)."
    }
    Warn2 "VM '$VMName' exists and -Force was given. Removing it and its disks."
    if ($existing.State -ne 'Off') { Stop-VM -Name $VMName -TurnOff -Force }
    Get-VMHardDiskDrive -VMName $VMName | ForEach-Object {
        if (Test-Path $_.Path) { Remove-Item $_.Path -Force }
    }
    Remove-VM -Name $VMName -Force
}

$vmDir  = Join-Path $ArtifactRoot $VMName
$dlDir  = Join-Path $ArtifactRoot 'download'
New-Item -ItemType Directory -Force -Path $vmDir, $dlDir | Out-Null
Info "Artifacts: $ArtifactRoot"

$free = (Get-PSDrive -Name ($ArtifactRoot.Substring(0,1))).Free
$needed = ($SystemDiskGB + 4) * 1GB
if ($free -lt $needed) {
    Die ("Not enough free space on {0}: {1:N1} GB free, need at least {2:N1} GB for the initial build." -f `
         $ArtifactRoot.Substring(0,2), ($free/1GB), ($needed/1GB))
}
Good ("{0:N1} GB free on {1}" -f ($free/1GB), $ArtifactRoot.Substring(0,2))

# ─── 1. download + verify the Debian raw image ────────────────────────────────
Step "Fetching Debian 13 trixie cloud image ($ImageVariant, build $DebianBuild)"

$base    = "https://cloud.debian.org/images/cloud/trixie/$DebianBuild"
$rawName = "debian-13-$ImageVariant-amd64-$DebianBuild.raw"
$rawPath = Join-Path $dlDir $rawName
$sumPath = Join-Path $dlDir "SHA512SUMS-$DebianBuild"

if (-not (Test-Path $sumPath)) {
    Info "GET $base/SHA512SUMS"
    & curl.exe -fSL --retry 3 -o $sumPath "$base/SHA512SUMS"
    if ($LASTEXITCODE -ne 0) { Die "Could not download SHA512SUMS from $base. Is build '$DebianBuild' still published? Check https://cdimage.debian.org/images/cloud/trixie/" }
}

$expected = (Get-Content $sumPath | Where-Object { $_ -match [regex]::Escape($rawName) + '\s*$' } |
             Select-Object -First 1) -split '\s+' | Select-Object -First 1
if (-not $expected) {
    Info "Names present in SHA512SUMS:"
    Get-Content $sumPath | ForEach-Object { ($_ -split '\s+')[-1] } | Where-Object { $_ -like '*.raw' } | ForEach-Object { Info "  $_" }
    Die "'$rawName' is not listed in SHA512SUMS. Adjust -ImageVariant/-DebianBuild to match one of the names above."
}

# Resume rather than restart. This is a ~3 GiB transfer over a link that has already dropped
# once; without -C - an interruption at 95% throws away everything. curl -C - starts at 0 when
# the file is absent, resumes from the current length when it is partial, and reports 416 when
# the server says there is nothing left to fetch — which is success, not failure.
$expectedSize = 3221225472
$haveSize = if (Test-Path $rawPath) { (Get-Item $rawPath).Length } else { 0 }

if ($haveSize -eq $expectedSize) {
    Info 'Image already present at full size; verifying checksum.'
} else {
    if ($haveSize -gt 0) {
        Info ("Resuming from {0:N0} MiB of {1:N0} MiB" -f ($haveSize / 1MB), ($expectedSize / 1MB))
    } else {
        Info "GET $base/$rawName  (~3 GiB, this takes a while)"
    }
    & curl.exe -fL -C - --retry 5 --retry-delay 5 --retry-all-errors `
               --progress-bar -o $rawPath "$base/$rawName"
    $curlRc = $LASTEXITCODE
    $nowSize = if (Test-Path $rawPath) { (Get-Item $rawPath).Length } else { 0 }

    # curl exits 33 when the server refuses ranged requests, and 36 on a bad resume attempt.
    # Both mean "resume is not possible", so fall back to a clean restart once.
    if (($curlRc -eq 33 -or $curlRc -eq 36) -and $nowSize -lt $expectedSize) {
        Warn2 'Server refused the ranged request; restarting the download from zero.'
        Remove-Item $rawPath -Force -ErrorAction SilentlyContinue
        & curl.exe -fL --retry 5 --retry-delay 5 --retry-all-errors `
                   --progress-bar -o $rawPath "$base/$rawName"
        $curlRc = $LASTEXITCODE
        $nowSize = if (Test-Path $rawPath) { (Get-Item $rawPath).Length } else { 0 }
    }

    if ($nowSize -ne $expectedSize) {
        Die ("Download incomplete: {0:N0} of {1:N0} bytes (curl rc={2}). Re-run to resume." -f `
             $nowSize, $expectedSize, $curlRc)
    }
}

Info 'Computing SHA512...'
$actual = (Get-FileHash -Path $rawPath -Algorithm SHA512).Hash.ToLower()
if ($actual -ne $expected.ToLower()) {
    Remove-Item $rawPath -Force
    Die "SHA512 MISMATCH. Expected $expected, got $actual. Corrupt download deleted; re-run."
}
Good 'SHA512 verified.'

# ─── 2. raw -> VHDX (no qemu-img, no third-party tooling) ─────────────────────
Step "Building system disk ($SystemDiskGB GB VHDX) from the raw image"

$sysVhd = Join-Path $vmDir 'system.vhdx'
if (Test-Path $sysVhd) { Remove-Item $sysVhd -Force }
New-VHD -Path $sysVhd -SizeBytes ($SystemDiskGB * 1GB) -Dynamic -BlockSizeBytes 1MB | Out-Null

$mounted = $null
try {
    $mounted = Mount-VHD -Path $sysVhd -NoDriveLetter -Passthru | Get-Disk
    # Windows refuses raw sector writes to an online disk.
    Set-Disk -Number $mounted.Number -IsOffline $true
    Set-Disk -Number $mounted.Number -IsReadOnly $false

    $src = [IO.File]::OpenRead($rawPath)
    $dst = New-Object IO.FileStream(
        "\\.\PhysicalDrive$($mounted.Number)",
        [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None,
        1MB, [IO.FileOptions]::WriteThrough)
    try {
        $buf   = New-Object byte[] (4MB)
        $total = $src.Length
        $done  = 0L
        $tick  = 0
        while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {
            # Raw device writes must be sector-aligned; pad the final short read.
            $w = if ($n % 4096) { [int][math]::Ceiling($n / 4096) * 4096 } else { $n }
            $dst.Write($buf, 0, $w)
            $done += $n
            if ((++$tick % 64) -eq 0) {
                Write-Progress -Activity 'Writing raw image into VHDX' `
                    -Status ("{0:N0} / {1:N0} MiB" -f ($done/1MB), ($total/1MB)) `
                    -PercentComplete ([int](100 * $done / $total))
            }
        }
        $dst.Flush()
    } finally {
        $dst.Dispose(); $src.Dispose()
        Write-Progress -Activity 'Writing raw image into VHDX' -Completed
    }
} finally {
    if ($mounted) { Dismount-VHD -Path $sysVhd }
}
Good 'System disk written. cloud-init growpart will expand root on first boot.'

# ─── 3. SSH keypair for non-interactive control ───────────────────────────────
Step 'SSH keypair'

$keyDir = Join-Path $ArtifactRoot 'ssh'
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
$keyPath = Join-Path $keyDir 'depsis_ci_ed25519'
if (-not (Test-Path $keyPath)) {
    if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
        Die 'ssh-keygen not found. Install the Windows OpenSSH Client optional feature.'
    }
    & ssh-keygen -t ed25519 -N '""' -C 'depsis-ci' -f $keyPath | Out-Null
    Good "Generated $keyPath"
} else {
    Info 'Reusing existing keypair.'
}
$pubKey = (Get-Content "$keyPath.pub" -Raw).Trim()

# ─── 4. cloud-init NoCloud seed: a FAT volume labelled CIDATA ─────────────────
Step 'Building cloud-init seed disk (FAT, label CIDATA)'

$seedVhd = Join-Path $vmDir 'seed.vhdx'
if (Test-Path $seedVhd) { Remove-Item $seedVhd -Force }
New-VHD -Path $seedVhd -SizeBytes 64MB -Fixed | Out-Null

$seedDisk = $null
try {
    $seedDisk = Mount-VHD -Path $seedVhd -Passthru | Get-Disk
    $vol = Initialize-Disk -Number $seedDisk.Number -PartitionStyle MBR -PassThru |
           New-Partition -UseMaximumSize -AssignDriveLetter |
           Format-Volume -FileSystem FAT -NewFileSystemLabel 'CIDATA' -Force -Confirm:$false
    $drv = $vol.DriveLetter

    # cloud-init rejects a BOM on the '#cloud-config' header and dislikes CRLF.
    # PowerShell 5.1's Set-Content/Out-File add both, so write bytes explicitly.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    function Write-Seed ([string] $name, [string] $text) {
        [IO.File]::WriteAllText("${drv}:\$name", ($text -replace "`r`n", "`n"), $utf8NoBom)
    }

    $userData = @"
#cloud-config
hostname: $VMName
fqdn: $VMName.depsis.test
preserve_hostname: false

users:
  - name: depsis
    groups: [sudo, adm]
    sudo: 'ALL=(ALL) NOPASSWD:ALL'
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $pubKey

ssh_pwauth: false
disable_root: true

# Contrib is required for OpenZFS on Debian; it is DKMS-built against the running kernel,
# so linux-headers must be present BEFORE zfs-dkms is configured.
apt:
  sources_list: |
    deb http://deb.debian.org/debian trixie main contrib non-free-firmware
    deb http://deb.debian.org/debian trixie-updates main contrib non-free-firmware
    deb http://security.debian.org/debian-security trixie-security main contrib non-free-firmware

package_update: true
package_upgrade: false
packages:
  - linux-headers-amd64
  - build-essential
  - dpkg-dev
  - hyperv-daemons      # KVP/fcopy/VSS guest daemons; gives the host guest-IP discovery
  - lsscsi
  - sg3-utils           # sg_inq / sg_vpd, to inspect VPD page 0x83 in the PoC
  - smartmontools
  - acl                 # getfacl/setfacl - ADR-0004 depends on these
  - attr                # getfattr, to inspect security.NTACL
  - jq
  - git
  - curl

write_files:
  - path: /etc/depsis-poc-build.json
    permissions: '0644'
    content: |
      {
        "vm": "$VMName",
        "debian_build": "$DebianBuild",
        "image_variant": "$ImageVariant",
        "provisioned_by": "deploy/vm/provision-debian.ps1"
      }

runcmd:
  # zfs-dkms pulls in a licence acceptance prompt; preseed it for unattended install.
  - [ sh, -c, "echo 'zfs-dkms zfs-dkms/note-incompatible-licenses note true' | debconf-set-selections" ]
  - [ sh, -c, "DEBIAN_FRONTEND=noninteractive apt-get install -y zfsutils-linux zfs-dkms zfs-zed" ]
  - [ sh, -c, "DEBIAN_FRONTEND=noninteractive apt-get install -y samba smbclient samba-vfs-modules" ]
  - [ sh, -c, "DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib" ]
  - [ sh, -c, "modprobe zfs && zfs version > /var/log/depsis-zfs-version.txt 2>&1 || true" ]
  - [ sh, -c, "dpkg -l samba postgresql zfsutils-linux > /var/log/depsis-pkg-versions.txt 2>&1 || true" ]
  - [ sh, -c, "touch /var/lib/depsis-cloud-init-done" ]

final_message: "DEPSIS PoC VM ready after `$UPTIME seconds."
"@

    # Two NICs: one for outbound apt over the Default Switch (DHCP, subnet changes on host
    # reboot), one static on the Internal switch as the stable control plane. Matching on MAC
    # rather than interface name because predictable-name assignment order is not guaranteed.
    $networkConfig = @"
version: 2
ethernets:
  wan:
    match:
      macaddress: '$(Format-Mac $WanMac)'
    dhcp4: true
    dhcp6: false
  lab:
    match:
      macaddress: '$(Format-Mac $LabMac)'
    dhcp4: false
    addresses:
      - $LabGuestIP/$LabPrefix
"@

    Write-Seed 'user-data'      $userData
    Write-Seed 'meta-data'      "instance-id: $VMName-001`nlocal-hostname: $VMName`n"
    Write-Seed 'network-config' $networkConfig
    Good "Seed written to ${drv}: (user-data, meta-data, network-config)"
} finally {
    if ($seedDisk) { Dismount-VHD -Path $seedVhd }
}

# ─── 5. the stable control-plane switch ───────────────────────────────────────
Step "Internal switch '$LabSwitch' ($LabHostIP/$LabPrefix)"

if (-not (Get-VMSwitch -Name $LabSwitch -ErrorAction SilentlyContinue)) {
    New-VMSwitch -Name $LabSwitch -SwitchType Internal | Out-Null
    Good "Created switch '$LabSwitch'."
} else {
    Info 'Switch already exists.'
}

$alias = "vEthernet ($LabSwitch)"
$have  = Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object IPAddress -eq $LabHostIP
if (-not $have) {
    New-NetIPAddress -InterfaceAlias $alias -IPAddress $LabHostIP -PrefixLength $LabPrefix | Out-Null
    Good "Host address $LabHostIP/$LabPrefix assigned."
} else {
    Info 'Host address already assigned.'
}
# Deliberately no New-NetNat here: WinNAT permits one NAT network per host and the Default
# Switch already holds it. Outbound traffic goes over the Default Switch NIC instead.

# ─── 6. the VM ────────────────────────────────────────────────────────────────
Step "Creating VM '$VMName'"

New-VM -Name $VMName -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) `
       -NoVHD -Path $ArtifactRoot -SwitchName 'Default Switch' | Out-Null

Set-VMProcessor -VMName $VMName -Count $CpuCount
# Static memory: ZFS ARC sizes itself against total RAM and reacts badly to balloon changes.
Set-VMMemory -VMName $VMName -DynamicMemoryEnabled $false -StartupBytes ($MemoryGB * 1GB)

# AutomaticCheckpoints OFF: otherwise every start inserts AVHDX differencing disks beneath the
#   pool, which invalidates any I/O or failure-injection result taken from ZFS.
# CheckpointType Standard: production checkpoints require guest VSS, which Linux does not provide.
# AutomaticStopAction ShutDown: the default 'Save' dumps RAM to disk and can confuse ZFS on resume.
Set-VM -Name $VMName `
       -AutomaticCheckpointsEnabled $false `
       -CheckpointType Standard `
       -AutomaticStopAction ShutDown `
       -AutomaticStartAction Nothing

Set-VMNetworkAdapter -VMName $VMName -Name 'Network Adapter' -StaticMacAddress $WanMac
Add-VMNetworkAdapter -VMName $VMName -Name 'lab' -SwitchName $LabSwitch -StaticMacAddress $LabMac

Add-VMHardDiskDrive -VMName $VMName -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 0 -Path $sysVhd
Add-VMHardDiskDrive -VMName $VMName -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 1 -Path $seedVhd
Good 'System and seed disks attached.'

# ─── 7. ZFS vdevs, each with its own page-0x83 identifier ─────────────────────
Step "Creating $VdevCount ZFS vdev disks ($VdevSizeGB GB each)"

$expectedIds = [ordered]@{}
0..($VdevCount - 1) | ForEach-Object {
    $p = Join-Path $vmDir "vdev$_.vhdx"
    if (Test-Path $p) { Remove-Item $p -Force }
    # A fresh New-VHD per disk. Copying a VHDX would duplicate its page-0x83 identifier and the
    # disks would collide in /dev/disk/by-id inside the guest.
    New-VHD -Path $p -SizeBytes ($VdevSizeGB * 1GB) -Dynamic -BlockSizeBytes 1MB | Out-Null
    Add-VMHardDiskDrive -VMName $VMName -ControllerType SCSI -ControllerNumber 0 `
                        -ControllerLocation ($_ + 2) -Path $p
    $expectedIds["vdev$_"] = @{
        path           = $p
        diskIdentifier = (Get-VHD -Path $p).DiskIdentifier
        scsiLocation   = $_ + 2
    }
    Info ("vdev$_  DiskIdentifier = {0}" -f $expectedIds["vdev$_"].diskIdentifier)
}

# The guest-side PoC asserts these appear in /dev/disk/by-id, turning risk R1
# (wrong-disk destruction) into a machine-checkable invariant instead of a hope.
$expectedIds | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $vmDir 'expected-disk-ids.json') -Encoding UTF8
Good "Expected identifiers recorded in $vmDir\expected-disk-ids.json"

# ─── 8. firmware ──────────────────────────────────────────────────────────────
Step 'Firmware / Secure Boot'

$sysDrive = Get-VMHardDiskDrive -VMName $VMName -ControllerNumber 0 -ControllerLocation 0
try {
    Set-VMFirmware -VMName $VMName -EnableSecureBoot On `
                   -SecureBootTemplate 'MicrosoftUEFICertificateAuthority' `
                   -FirstBootDevice $sysDrive
    Good "Secure Boot on, template MicrosoftUEFICertificateAuthority (required for Debian's shim)."
} catch {
    Warn2 "Named template rejected: $($_.Exception.Message)"
    Warn2 'Falling back to Secure Boot OFF so the PoC is not blocked. Available templates:'
    Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_SecureBootTemplate -ErrorAction SilentlyContinue |
        ForEach-Object { Warn2 ("  {0}  {1}" -f $_.ElementName, $_.InstanceID) }
    Set-VMFirmware -VMName $VMName -EnableSecureBoot Off -FirstBootDevice $sysDrive
}

Enable-VMIntegrationService -VMName $VMName -Name 'Guest Service Interface'
# Cheapest unattended-boot debugger; Debian cloud images already enable ttyS0.
Set-VMComPort -VMName $VMName -Number 1 -Path "\\.\pipe\$VMName-console"
Good "Serial console on \\.\pipe\$VMName-console"

# ─── 9. golden checkpoint, then boot ──────────────────────────────────────────
Step 'Checkpoint and start'

Checkpoint-VM -Name $VMName -SnapshotName 'pristine-preboot'
Good "Checkpoint 'pristine-preboot' taken (reset point for repeatable PoC runs)."

Start-VM -Name $VMName
Good 'VM started. cloud-init first boot installs ZFS/Samba/PostgreSQL; allow several minutes.'

# ─── done ─────────────────────────────────────────────────────────────────────
Write-Host @"

────────────────────────────────────────────────────────────────────────────
  DEPSIS test VM '$VMName' provisioned.

  Wait for cloud-init, then connect:
      ssh -i "$keyPath" depsis@$LabGuestIP

  Confirm first boot finished:
      ssh -i "$keyPath" depsis@$LabGuestIP 'ls -l /var/lib/depsis-cloud-init-done'

  Watch the boot on the serial console if it does not come up:
      Get-VMComPort -VMName $VMName

  Reset to the clean state between PoC runs:
      Restore-VMCheckpoint -VMName $VMName -Name 'pristine-preboot' -Confirm:`$false

  Next: run the Phase 0 PoCs. P0-B (ADR-0004) and P0-D (ADR-0011) gate Phase 1.
────────────────────────────────────────────────────────────────────────────
"@ -ForegroundColor Green

#Requires -Version 5.1
<#
.SYNOPSIS
    Dump everything needed to diagnose why the DEPSIS PoC VM is unreachable.

.DESCRIPTION
    Read-only. Starts nothing, changes nothing, deletes nothing. Run elevated and paste the
    output. The serial console capture at the end is usually the part that answers the question,
    because a VM that fails Secure Boot or cannot find root says so there and nowhere else.
#>
[CmdletBinding()]
param(
    [string] $VMName = 'depsis-poc',
    [int]    $ConsoleSeconds = 8
)

$ErrorActionPreference = 'Continue'

function Head ($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Head 'Elevation'
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'NOT ELEVATED — Hyper-V queries below will fail. Re-run as Administrator.' -ForegroundColor Red
} else {
    Write-Host 'elevated' -ForegroundColor Green
}

Head 'VM state'
Get-VM -Name $VMName -ErrorAction SilentlyContinue |
    Select-Object Name, State, Status, Uptime, MemoryAssigned, ProcessorCount,
                  AutomaticStopAction, AutomaticCheckpointsEnabled |
    Format-List

Head 'Firmware / boot order'
# If Secure Boot is On with a template Debian's shim is not signed against, the VM powers on and
# then sits at a firmware error with no disk activity. This is the first thing to rule out.
Get-VMFirmware -VMName $VMName -ErrorAction SilentlyContinue |
    Select-Object SecureBoot, SecureBootTemplate, SecureBootTemplateId |
    Format-List
Write-Host 'BootOrder:'
(Get-VMFirmware -VMName $VMName -ErrorAction SilentlyContinue).BootOrder |
    ForEach-Object { "  {0}  {1}" -f $_.BootType, $_.Device }

Head 'Disks attached'
Get-VMHardDiskDrive -VMName $VMName -ErrorAction SilentlyContinue |
    Select-Object ControllerType, ControllerNumber, ControllerLocation, Path |
    Format-Table -AutoSize

Head 'Disk identifiers as Hyper-V sees them (compare to expected-disk-ids.json)'
Get-VMHardDiskDrive -VMName $VMName -ErrorAction SilentlyContinue | ForEach-Object {
    $v = Get-VHD -Path $_.Path -ErrorAction SilentlyContinue
    if ($v) {
        "{0,-16} {1,-38} {2,10:N0} MB / {3,6:N0} GB  {4}" -f `
            (Split-Path $_.Path -Leaf), $v.DiskIdentifier, ($v.FileSize / 1MB), ($v.Size / 1GB), $v.VhdType
    }
}

Head 'Network adapters'
Get-VMNetworkAdapter -VMName $VMName -ErrorAction SilentlyContinue |
    Select-Object Name, SwitchName, MacAddress, Status, @{n='IPs';e={$_.IPAddresses -join ', '}} |
    Format-Table -AutoSize
Write-Host 'Note: IPs come from the KVP integration service. Blank means either the guest is down,'
Write-Host 'hyperv-daemons is not running yet, or cloud-init has not configured the interface.'

Head 'Integration services'
Get-VMIntegrationService -VMName $VMName -ErrorAction SilentlyContinue |
    Select-Object Name, Enabled, PrimaryStatusDescription |
    Format-Table -AutoSize

Head 'Checkpoints'
Get-VMSnapshot -VMName $VMName -ErrorAction SilentlyContinue |
    Select-Object Name, CreationTime, ParentSnapshotName |
    Format-Table -AutoSize

Head 'Host switch'
Get-VMSwitch -Name 'DEPSIS-Lab' -ErrorAction SilentlyContinue |
    Select-Object Name, SwitchType, AllowManagementOS | Format-Table -AutoSize
Get-NetIPAddress -InterfaceAlias 'vEthernet (DEPSIS-Lab)' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Select-Object IPAddress, PrefixLength | Format-Table -AutoSize

Head "Serial console (reading $ConsoleSeconds s from \\.\pipe\$VMName-console)"
# This is the highest-value part. Debian cloud images enable ttyS0, so boot messages, a Secure
# Boot rejection, a missing root device, or a cloud-init failure all land here.
$pipeName = "$VMName-console"
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::In)
    $pipe.Connect(3000)
    $reader = New-Object System.IO.StreamReader($pipe)
    $deadline = (Get-Date).AddSeconds($ConsoleSeconds)
    $got = $false
    while ((Get-Date) -lt $deadline) {
        if ($reader.Peek() -ge 0) {
            $line = $reader.ReadLine()
            if ($null -ne $line) { Write-Host "  $line"; $got = $true }
        } else {
            Start-Sleep -Milliseconds 200
        }
    }
    if (-not $got) {
        Write-Host '  (no output — the guest is not writing to ttyS0 right now)' -ForegroundColor Yellow
        Write-Host '  A booted-and-idle Linux is silent here. Silence alone is not a failure.' -ForegroundColor Yellow
    }
    $reader.Dispose(); $pipe.Dispose()
} catch {
    Write-Host "  could not attach to the console pipe: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  (the pipe only exists while the VM is running)' -ForegroundColor Yellow
}

Head 'Done'
Write-Host 'Paste all of the above.'

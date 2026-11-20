param([switch]$Show)

$ErrorActionPreference = 'Stop'
$reviewFile = $env:OMNEME_REVIEW_FILE
if (-not (Test-Path -LiteralPath $reviewFile -PathType Leaf)) {
    throw 'The saved Omneme review was not found.'
}

if (-not $Show) {
    # Let the worker finish while the alert remains available on the desktop.
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-File', ('"' + $PSCommandPath + '"'), '-Show'
    )
    return
}

$body = ((Get-Content -LiteralPath $reviewFile -Raw -Encoding UTF8) -split '\r?\n', 3)[2].Trim()
if ($body.Length -gt 700) { $body = $body.Substring(0, 700) + '…' }
# OMN-018: name the PENDING decision first so truncation never hides it. Nothing here approves it.
if ($env:OMNEME_DECISION_ID -match '^DEC-OMN-\d{3,}$') {
    $body = "Decision $($env:OMNEME_DECISION_ID) is PENDING: approve or reject it in Work.`r`n`r`n" + $body
}
$popup = New-Object -ComObject WScript.Shell
# Yes/No, information icon, default No, and a topmost window.
$choice = $popup.Popup($body + "`r`n`r`nOpen the full saved review?", 0, "Omneme review ready - $env:OMNEME_REVIEW_TASK", 0x1124)
if ($choice -eq 6) {
    Start-Process -FilePath notepad.exe -ArgumentList ('"' + $reviewFile + '"')
}

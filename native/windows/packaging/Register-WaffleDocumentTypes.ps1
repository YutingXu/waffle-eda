# Add this portable copy of Waffle EDA to Open with and to its record URL scheme.
[CmdletBinding()]
param([switch]$Unregister)
$ErrorActionPreference = "Stop"
$editor = Join-Path $PSScriptRoot "Waffle.exe"
if (-not $Unregister -and -not (Test-Path -LiteralPath $editor -PathType Leaf)) {
    throw "Extract the portable Waffle zip and run this script next to Waffle.exe."
}
$open = '"{0}" "%1"' -f $editor
$types = [ordered]@{
    wpcb = 'Waffle EDA PCB layout'
    wsch = 'Waffle EDA schematic'
    wlib = 'Waffle EDA component library'
    wdraw = 'Waffle EDA drawing'
    wpanel = 'Waffle EDA board panel'
}
$classes = if ($Unregister) { [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes', $true) }
           else { [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes') }
if ($null -eq $classes) { return }
try {
    if ($Unregister) {
        $command = $classes.OpenSubKey('waffle\shell\open\command')
        if ($null -ne $command) {
            try { $belongsHere = $open -ceq $command.GetValue('') } finally { $command.Dispose() }
            if ($belongsHere) { $classes.DeleteSubKeyTree('waffle', $false) }
        }
    } else {
        $protocol = $classes.CreateSubKey('waffle')
        try {
            $protocol.SetValue('', 'URL:Waffle EDA record link')
            $protocol.SetValue('URL Protocol', '')
            $command = $protocol.CreateSubKey('shell\open\command')
            try { $command.SetValue('', $open) } finally { $command.Dispose() }
        } finally { $protocol.Dispose() }
    }
    foreach ($extension in $types.Keys) {
        $progId = "Waffle.Document.$extension"
        $openWith = ".$extension\OpenWithProgids"
        if ($Unregister) {
            $command = $classes.OpenSubKey("$progId\shell\open\command")
            if ($null -eq $command) { continue }
            try { $belongsHere = $open -ceq $command.GetValue('') } finally { $command.Dispose() }
            if (-not $belongsHere) { continue }
            $choices = $classes.OpenSubKey($openWith, $true)
            if ($null -ne $choices) {
                try { $choices.DeleteValue($progId, $false) } finally { $choices.Dispose() }
            }
            $classes.DeleteSubKeyTree($progId, $false)
        } else {
            $type = $classes.CreateSubKey($progId)
            try {
                $type.SetValue('', $types[$extension])
                $command = $type.CreateSubKey('shell\open\command')
                try { $command.SetValue('', $open) } finally { $command.Dispose() }
                $icon = $type.CreateSubKey('DefaultIcon')
                try { $icon.SetValue('', ('"{0}",0' -f $editor)) } finally { $icon.Dispose() }
            } finally { $type.Dispose() }
            $choices = $classes.CreateSubKey($openWith)
            try { $choices.SetValue($progId, '') } finally { $choices.Dispose() }
        }
    }
} finally { $classes.Dispose() }
if ($Unregister) { Write-Host 'Removed this Waffle copy from Open with.' }
else { Write-Host 'Choose Waffle EDA under Open with to associate each file type.' }

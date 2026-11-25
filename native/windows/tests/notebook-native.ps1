# Exercise the actual host assembly under Windows PowerShell 5.1 -Mta, matching the desktop media queue.
param([Parameter(Mandatory=$true)][string]$WaffleExe)
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path $WaffleExe))
$platform = [Activator]::CreateInstance($assembly.GetType('Waffle.Windows.WinFs',$true),$true)
$decode = $platform.GetType().GetMethod('Decode')
$utf8 = New-Object Text.UTF8Encoding($false)
# Invoke the codec with CLR arguments so Windows PowerShell does not pass PSObject wrappers.
Add-Type -TypeDefinition @'
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
public static class WaffleNotebookCodecProof
{
    public static object Decode(MethodInfo method, object platform, Dictionary<string, object> options, byte[] data)
    {
        return method.Invoke(platform, new object[] { options, data, CancellationToken.None });
    }
}
'@
function Invoke-Codec([hashtable]$Options,[byte[]]$Bytes) {
    $map = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    foreach ($key in $Options.Keys) { $map.Add($key,$Options[$key]) }
    [WaffleNotebookCodecProof]::Decode($decode,$platform,$map,$Bytes)
}
# A deterministic PDF with offset CropBox, clockwise quarter-turn and double-size user units.
$content = "1 0 0 rg 50 25 100 100 re f 0 0 1 rg 150 25 100 100 re f`n"
$objects = @(
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /CropBox [50 25 250 125] /Rotate 90 /UserUnit 2 /Resources << >> /Contents 4 0 R >>',
    ("<< /Length " + $content.Length + " >>`nstream`n" + $content + "endstream"))
$pdf = "%PDF-1.7`n"
$offsets = @()
for ($i=0;$i -lt $objects.Count;$i++) {
    $offsets += $utf8.GetByteCount($pdf)
    $pdf += (($i+1).ToString() + " 0 obj`n" + $objects[$i] + "`nendobj`n")
}
$xref = $utf8.GetByteCount($pdf)
$pdf += "xref`n0 5`n0000000000 65535 f `n"
foreach ($offset in $offsets) { $pdf += ('{0:0000000000} 00000 n ' -f $offset) + "`n" }
$pdf += "trailer`n<< /Size 5 /Root 1 0 R >>`nstartxref`n$xref`n%%EOF`n"
$bytes = $utf8.GetBytes($pdf)
$info = Invoke-Codec @{op='pdfInfo'} $bytes
if ($info['pages'] -ne 1) { throw 'Incorrect PDF page count.' }
foreach ($half in @(0,1)) {
    $region = New-Object 'System.Collections.Generic.List[object]'
    foreach ($n in @(0,($half*500000),1000000,(($half+1)*500000))) { $region.Add([int]$n) }
    $image = Invoke-Codec @{op='pdfPage';page=1;side=100;region=$region} $bytes
    # PdfPage.Size is a WinRT Size with single-precision DIP values.
    $physical = [double[]]$image['physical']
    $correctSize = $physical.Count -eq 2 -and
        [Math]::Abs($physical[0] - 200) -le 0.001 -and [Math]::Abs($physical[1] - 400) -le 0.001
    if (!$correctSize -or $image['width'] -ne 100 -or $image['height'] -ne 100) {
        throw ("PDF crop {0}: expected 100x100 pixels and 200x400 pt; got {1}x{2} pixels and {3} pt." -f
            $half, $image['width'], $image['height'], ($physical -join 'x'))
    }
    $raster = Invoke-Codec @{op='decode';mediaType='image/png';side=100} ([Convert]::FromBase64String($image['png']))
    if (($raster['extent'] -join ',') -ne '100,100') { throw 'The encoded PDF crop has an incorrect extent.' }
    $rgba = [Convert]::FromBase64String($raster['rgba'])
    $pixel = (50*100+50)*4
    $primary = if ($half -eq 0) {0} else {2}
    if ($rgba[$pixel+$primary] -lt 240 -or $rgba[$pixel+1] -gt 15 -or $rgba[$pixel+2-$primary] -gt 15 -or $rgba[$pixel+3] -ne 255) {
        throw ("PDF crop {0}: unexpected center RGBA {1}." -f $half, ($rgba[$pixel..($pixel+3)] -join ','))
    }
}
Write-Output 'Windows.Data.Pdf physical units, rotation, both crop regions, PNG replay and straight RGBA passed.'

# Exercise bitmap-only clipboard conversion without altering the interactive clipboard.
$dib = New-Object byte[] 48
[BitConverter]::GetBytes([int]40).CopyTo($dib,0)
[BitConverter]::GetBytes([int]2).CopyTo($dib,4)
[BitConverter]::GetBytes([int]1).CopyTo($dib,8)
$dib[12] = 1; $dib[14] = 24
$dib[42] = 255; $dib[44] = 255
$converter = $assembly.GetType('Waffle.Windows.WinNotebookClipboard',$true).GetMethod('Png',
    [Reflection.BindingFlags]'Static,NonPublic')
$arguments = New-Object object[] 1
$arguments[0] = $dib
$png = [byte[]]$converter.Invoke($null,$arguments)
$pixels = Invoke-Codec @{op='decode';mediaType='image/png';side=2} $png
$expected = '255,0,0,255,0,255,0,255'
if ($pixels['width'] -ne 2 -or $pixels['height'] -ne 1 -or
    ([Convert]::FromBase64String($pixels['rgba']) -join ',') -ne $expected) {
    throw 'The two bitmap-only clipboard pixels changed during PNG conversion.'
}
Write-Output 'The bitmap-only clipboard encoder retained both original pixels in its PNG.'

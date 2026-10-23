param([Parameter(Mandatory=$true)][string]$SourcePath,[Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath,[Text.Encoding]::UTF8)) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
[void][IO.Directory]::CreateDirectory($ArtifactDirectory)
$watch=[Diagnostics.Stopwatch]::StartNew()
$frames=64
$indicatorText='DSH '+[char]0x6b63+[char]0x5728+[char]0x64cd+[char]0x4f5c+[char]0x684c+[char]0x9762
for($i=0;$i -lt $frames;$i++) {
  $image=[DshTakeover.OverlayVisuals]::DrawFrame(960,540,$indicatorText,'top',$i/4.0)
  try {
    if($i -eq 0) {
      $outer=$image.GetPixel(0,270).A;$inner=$image.GetPixel(16,270).A;$center=$image.GetPixel(480,270).A
      if(-not ($outer -ge 160 -and $outer -gt $inner -and $inner -ge 70 -and $center -eq 0)){throw 'Edge must be visible and fade inward to a transparent center'}
      $first=$image.GetPixel(0,270).ToArgb()
    }
    if($i -eq 16 -and $first -eq $image.GetPixel(0,270).ToArgb()){throw 'Aurora colors did not move over time'}
    $image.Save((Join-Path $ArtifactDirectory ('frame-{0:D3}.png' -f $i)),[Drawing.Imaging.ImageFormat]::Png)
  }finally{$image.Dispose()}
}
$displayCases=@()
foreach($display in @(@(1920,1200,144),@(2560,1600,144),@(3840,2160,192))) {
  $width=$display[0];$height=$display[1];$dpi=$display[2]
  $depth=[DshTakeover.OverlayVisuals]::EdgeDepth($width,$height,$dpi)
  $image=[DshTakeover.OverlayVisuals]::DrawFrame($width,$height,$indicatorText,'top',0,$dpi)
  try {
    $edge=$image.GetPixel(0,[int]($height/2)).A
    $inside=$image.GetPixel([int]($depth/3),[int]($height/2)).A
    $clear=$image.GetPixel($depth,[int]($height/2)).A
    if($edge -lt 160 -or $inside -lt 65 -or $inside -ge $edge -or $clear -ne 0){throw 'Display-size/DPI fade visibility failed'}
    $image.Save((Join-Path $ArtifactDirectory ('display-{0}x{1}-{2}dpi.png' -f $width,$height,$dpi)),[Drawing.Imaging.ImageFormat]::Png)
    $displayCases+=@{width=$width;height=$height;dpi=$dpi;depth=$depth;outerAlpha=$edge;oneThirdAlpha=$inside;pastEdgeAlpha=$clear}
  }finally{$image.Dispose()}
}
foreach($scale in @(1.0,1.5,2.0,3.0)) {
  foreach($left in @($false,$true)) {foreach($up in @($false,$true)) {
    $cursor=[DshTakeover.OverlayVisuals]::DrawPointer($scale,$left,$up)
    try {
      if($cursor.Width -ne [Math]::Ceiling(120*$scale) -or $cursor.Height -ne [Math]::Ceiling(84*$scale)){throw 'Pointer DPI layout mismatch'}
      if(-not $left -and -not $up -and $scale -eq 1.0) {
        if($cursor.GetPixel(9,24).A -ne 0){throw 'Old cursor ring is still present'}
        $blue=$cursor.GetPixel(29,39)
        if($blue.A -lt 180 -or $blue.B -le $blue.R){throw 'Arrow fill is not opaque blue'}
      }
      if($scale -eq 3.0 -and -not $left -and -not $up){$cursor.Save((Join-Path $ArtifactDirectory 'pointer-blue.png'),[Drawing.Imaging.ImageFormat]::Png)}
    }finally{$cursor.Dispose()}
  }}
}
$watch.Stop()
$result=@{ok=$true;frames=$frames;outerAlpha=$outer;innerAlpha=$inner;centerAlpha=$center;renderMilliseconds=$watch.ElapsedMilliseconds;displayCases=$displayCases;directory=$ArtifactDirectory}
[IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'render-result.json'),($result | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
$result | ConvertTo-Json -Depth 5 -Compress

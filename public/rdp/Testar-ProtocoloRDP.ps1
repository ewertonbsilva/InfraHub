<#
  Testar-ProtocoloRDP.ps1
  Testa o handler como o Windows o chamaria (powershell.exe -File handler "%1"),
  em modo -DryRun: NAO abre o mstsc e NAO mexe no registro.

  Uso:  .\Testar-ProtocoloRDP.ps1
#>
$handler = Join-Path $PSScriptRoot 'infrahub-rdp-handler.ps1'
if (-not (Test-Path $handler)) { throw "Nao achei $handler" }

function Invoke-Handler([string]$Url) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    # monta a linha de comando como o Windows faz: a URL entre aspas, como ARGUMENTO
    $arg = '"' + $Url.Replace('"', '\"') + '"'
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $handler + '" -DryRun ' + $arg
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd().Trim()
    $p.WaitForExit()
    [pscustomobject]@{ Saida = $out; Codigo = $p.ExitCode }
}

# [URL, esperado]  -> esperado = linha impressa em caso de aceite, ou $null se deve ser REJEITADO
$casos = @(
    @('infrahub-rdp://192.0.2.26',            'mstsc.exe /v:192.0.2.26'),
    @('infrahub-rdp://192.0.2.26/',           'mstsc.exe /v:192.0.2.26'),
    @('INFRAHUB-RDP://srv-ad01',              'mstsc.exe /v:srv-ad01'),
    @('infrahub-rdp://srv01.exemplo.com',     'mstsc.exe /v:srv01.exemplo.com'),
    @('infrahub-rdp://192.0.2.26:3390',       'mstsc.exe /v:192.0.2.26:3390'),
    @('infrahub-rdp://x'');calc;(''',         $null),   # tentativa de injecao
    @('infrahub-rdp://x" & calc & "',         $null),
    @('infrahub-rdp://192.0.2.26 /admin',     $null),   # espaco / argumento extra
    @('infrahub-rdp://192.0.2.26;calc',       $null),
    @('infrahub-rdp://$(calc)',               $null),
    @('infrahub-rdp://192.0.2.26`calc',       $null),
    @('infrahub-rdp://192.0.2.26:99999',      $null),   # porta fora da faixa
    @('infrahub-rdp://192.0.2.26:0',          $null),
    @('infrahub-rdp://',                      $null),
    @('file:///c:/windows/system32/calc.exe', $null)
)

$falhas = 0
foreach ($c in $casos) {
    $r = Invoke-Handler $c[0]
    $esperavaAceite = $null -ne $c[1]
    $aceitou = ($r.Codigo -eq 0 -and $r.Saida -ne '')
    $ok = if ($esperavaAceite) { $aceitou -and $r.Saida -eq $c[1] } else { -not $aceitou }
    if (-not $ok) { $falhas++ }
    $status = if ($ok) { 'OK    ' } else { 'FALHOU' }
    $resultado = if ($aceitou) { $r.Saida } else { 'rejeitado' }
    '{0} {1,-44} -> {2}' -f $status, $c[0], $resultado
}
''
if ($falhas -eq 0) { "Todos os $($casos.Count) casos passaram." } else { "$falhas caso(s) falharam."; exit 1 }

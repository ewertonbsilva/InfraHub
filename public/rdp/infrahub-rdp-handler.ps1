<#
  infrahub-rdp-handler.ps1
  Handler do protocolo infrahub-rdp:// -> abre o mstsc direto no host informado.

  SEGURANCA: a URL chega como ARGUMENTO do script (-File ... "%1"), ou seja, e tratada
  como DADO. Ela nunca e colada dentro de um comando do PowerShell (isso permitiria
  injecao de codigo por qualquer pagina/e-mail que dispare um link infrahub-rdp://).
  Alem disso o host e validado por regex; qualquer coisa fora do padrao e descartada.

  Uso manual (teste):  .\infrahub-rdp-handler.ps1 "infrahub-rdp://192.0.2.77"
  Teste sem abrir nada: .\infrahub-rdp-handler.ps1 -DryRun "infrahub-rdp://192.0.2.77"
#>
param(
    [Parameter(Position = 0)][string]$Url,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Msg) {
    try {
        $dir = Join-Path $env:LOCALAPPDATA 'InfraHub'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Add-Content -Path (Join-Path $dir 'rdp-handler.log') -Value ('{0:s} {1}' -f (Get-Date), $Msg)
    } catch { }
}

# Remove o esquema (sem diferenciar maiusculas) e a barra final.
$h = ($Url -replace '^infrahub-rdp://', '').TrimEnd('/')

# VALIDACAO OBRIGATORIA: so letras, numeros, ponto e hifen, com porta opcional.
# (\z = fim real do texto; nao aceita quebra de linha no final)
if ($h -notmatch '^[A-Za-z0-9.\-]+(:\d{1,5})?\z') {
    Write-Log "REJEITADO (formato invalido): $Url"
    exit 2
}
if ($h -match ':(\d+)\z') {
    $porta = [int]$Matches[1]
    if ($porta -lt 1 -or $porta -gt 65535) {
        Write-Log "REJEITADO (porta fora de 1-65535): $Url"
        exit 2
    }
}

if ($DryRun) {
    Write-Output "mstsc.exe /v:$h"
    exit 0
}

Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\mstsc.exe') -ArgumentList "/v:$h"

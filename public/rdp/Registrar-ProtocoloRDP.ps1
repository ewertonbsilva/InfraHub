<#
  Registrar-ProtocoloRDP.ps1
  Registra o protocolo infrahub-rdp:// para o USUARIO ATUAL (HKCU\Software\Classes\infrahub-rdp).
  Nao precisa de administrador, desde que o handler ja esteja em $HandlerDir.

  Uso:
    .\Registrar-ProtocoloRDP.ps1            # instala
    .\Registrar-ProtocoloRDP.ps1 -Remover   # desinstala

  GPO: use como script de LOGON do usuario (Configuracao do Usuario > Scripts > Logon >
  aba Scripts do PowerShell). Para o handler chegar em $HandlerDir sem direitos de
  administrador, distribua-o por Preferencias > Arquivos (veja README.md, secao RDP).
  Este script copia o handler que estiver ao lado dele, se tiver permissao para isso.
#>
param(
    [string]$HandlerDir = (Join-Path $env:ProgramData 'InfraHub'),
    [switch]$Remover
)

$ErrorActionPreference = 'Stop'
$chave   = 'HKCU:\Software\Classes\infrahub-rdp'
$handler = Join-Path $HandlerDir 'infrahub-rdp-handler.ps1'

if ($Remover) {
    if (Test-Path $chave) { Remove-Item -Path $chave -Recurse -Force }
    Write-Output 'Protocolo infrahub-rdp removido deste usuario.'
    return
}

# 1) Garante o handler no destino (copia o que estiver ao lado deste script).
$origem = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'infrahub-rdp-handler.ps1' } else { $null }
if ($origem -and (Test-Path $origem)) {
    try {
        New-Item -ItemType Directory -Force -Path $HandlerDir | Out-Null
        Copy-Item -Path $origem -Destination $handler -Force
    } catch {
        Write-Warning "Nao foi possivel copiar o handler para $HandlerDir ($($_.Exception.Message))."
    }
}
if (-not (Test-Path $handler)) {
    throw "Handler nao encontrado em $handler. Copie infrahub-rdp-handler.ps1 para la (GPO > Preferencias > Arquivos) ou rode este script como administrador."
}

# 2) Registra o protocolo. A URL vai como argumento ("%1"), nunca dentro de um -Command.
$comando = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $handler + '" "%1"'

New-Item -Path $chave -Force | Out-Null
Set-ItemProperty -Path $chave -Name '(default)' -Value 'URL:InfraHub RDP'
New-ItemProperty -Path $chave -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$chave\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$chave\shell\open\command" -Name '(default)' -Value $comando

Write-Output "Protocolo infrahub-rdp registrado para $env:USERNAME."
Write-Output "Handler: $handler"

$ErrorActionPreference = 'Stop'

$project = 'opencartify-inventory-integration'
$databaseHost = '127.0.0.1'
$databasePort = 55433
$databaseUser = 'opencartify_inventory_test'
$databaseName = 'opencartify_inventory_integration_test'
$workspace = Split-Path -Parent $PSScriptRoot
$apiDirectory = Join-Path $workspace 'apps/api'
$composeFile = Join-Path $workspace 'infra/docker/docker-compose.inventory-integration.yml'
$temporaryEnvironment = Join-Path ([System.IO.Path]::GetTempPath()) "opencartify-inventory-$([guid]::NewGuid().ToString('N')).env"
$password = "it$([guid]::NewGuid().ToString('N'))"
$databaseUrl = "postgresql://${databaseUser}:${password}@${databaseHost}:${databasePort}/${databaseName}?schema=public"
$succeeded = $false

function Assert-TestDatabaseTarget {
  param([string]$Url)

  try {
    $uri = [System.Uri]$Url
  } catch {
    throw 'Integration test target validation failed.'
  }

  if (
    $uri.Scheme -ne 'postgresql' -or
    $uri.Host -ne $databaseHost -or
    $uri.Port -ne $databasePort -or
    $uri.UserInfo.Split(':')[0] -ne $databaseUser -or
    $uri.AbsolutePath.Trim('/') -ne $databaseName
  ) {
    throw 'Integration tests refused a non-isolated database target.'
  }
}

function Invoke-Compose {
  param([string[]]$Arguments)

  & docker compose --env-file $temporaryEnvironment -p $project -f $composeFile @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw 'Integration test Compose command failed.'
  }
}

try {
  Assert-TestDatabaseTarget $databaseUrl

  $portListener = Get-NetTCPConnection -State Listen -LocalPort $databasePort -ErrorAction SilentlyContinue
  if ($portListener) {
    throw "Port $databasePort is already in use; integration tests were not started."
  }

  [System.IO.File]::WriteAllText(
    $temporaryEnvironment,
    "OPENCARTIFY_TEST_DB_PASSWORD=$password`n"
  )
  $env:DATABASE_URL = $databaseUrl

  Invoke-Compose @('up', '-d', '--wait')

  & pnpm --dir $apiDirectory exec prisma migrate deploy --config prisma7.integration-test.config.ts
  if ($LASTEXITCODE -ne 0) {
    throw 'Integration test migrations failed.'
  }

  & pnpm --dir $apiDirectory exec vitest run --config vitest.config.inventory-integration.ts
  if ($LASTEXITCODE -ne 0) {
    throw 'Inventory integration tests failed. Test database and logs are preserved for investigation.'
  }

  $expectedVolume = "${project}_inventory_integration_test_data"
  $projectVolumes = @(
    docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}'
  )
  if ($projectVolumes.Count -ne 1 -or $projectVolumes[0] -ne $expectedVolume) {
    throw 'Integration test cleanup refused because the Compose volume identity was unexpected.'
  }

  $volumeLabelsJson = docker volume inspect $expectedVolume --format '{{json .Labels}}'
  $volumeLabels = $volumeLabelsJson | ConvertFrom-Json
  $volumeProject = $volumeLabels.'com.docker.compose.project'
  if ($volumeProject -ne $project) {
    throw 'Integration test cleanup refused because the volume does not belong to the test project.'
  }

  $succeeded = $true
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue

  if ($succeeded) {
    Invoke-Compose @('down', '-v')
  }

  if (Test-Path -LiteralPath $temporaryEnvironment) {
    Remove-Item -LiteralPath $temporaryEnvironment -Force
  }
}

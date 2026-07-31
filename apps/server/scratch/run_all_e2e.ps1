Write-Host "Running e2e-mail on GreenMail..."
node scripts/e2e-mail.mjs

Write-Host "Running e2e-realtime on GreenMail..."
node scripts/e2e-realtime.mjs

Write-Host "Running e2e-mail on m.re.cx..."
node scripts/e2e-mail.mjs --real

Write-Host "Running e2e-realtime on m.re.cx..."
node scripts/e2e-realtime.mjs --real

Write-Host "All suites finished."

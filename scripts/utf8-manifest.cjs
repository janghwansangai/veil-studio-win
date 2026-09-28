// Rewrites whisper-cli.exe's embedded manifest (same byte length) to request the UTF-8 active code page,
// so command-line arguments (Korean file paths, Korean prompt words) reach whisper as UTF-8.
const fs = require('fs')
const file = process.argv[2]
const b = fs.readFileSync(file)
const start = b.indexOf('<assembly'), close = b.indexOf('</assembly>', start)
if (start < 0 || close < 0) throw new Error('manifest not found')
const end = close + '</assembly>'.length
const utf8 = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage></windowsSettings></application></assembly>'
if (b.slice(start, end).includes('activeCodePage')) { console.log('already patched'); process.exit(0) }
if (utf8.length > end - start) throw new Error(`manifest too long: ${utf8.length} > ${end - start}`)
Buffer.from(utf8.padEnd(end - start, ' ')).copy(b, start)
fs.writeFileSync(file, b)
console.log('patched', file, utf8.length, '/', end - start)

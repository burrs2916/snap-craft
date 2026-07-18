// 零依赖 ZIP 写入器 sanity 测试
// 1) CRC32 标准向量校验（"123456789" → 0xCBF43926）
// 2) 构建真实 zip 并写盘，交给系统 unzip 校验结构合法性
import { buildZip, crc32, dataUrlToBytes } from '../src/features/ai/zipStore.ts';
import { writeFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

// 1) CRC32 标准向量
const vec = crc32(new TextEncoder().encode('123456789'));
check('CRC32("123456789") === 0xCBF43926', vec === 0xcbf43926);

// 2) dataUrlToBytes
const b64 = 'data:image/png;base64,iVBORw0KGgo='; // 1x1 png-ish 前缀，仅测解码
const decoded = dataUrlToBytes(b64);
check('dataUrlToBytes 解出字节', !!decoded && decoded.length > 0);
check('dataUrlToBytes 对非法串返回 null', dataUrlToBytes('not-a-dataurl') === null);

// 3) 构建真实 zip
const hello = new TextEncoder().encode('Hello, SnapCraft ZIP! 中文测试\n');
const json = new TextEncoder().encode(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
const zip = buildZip([
  { name: 'hello.txt', data: hello },
  { name: 'data.json', data: json },
]);
check('zip 字节非空', zip.length > 0);
// 本地文件头签名 0x04034b50 little-endian = [0x50,0x4b,0x03,0x04]
check('首部是本地文件头签名 PK\\x03\\x04', zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04);
// 末部 EOCD 签名 0x06054b50 = [0x50,0x4b,0x05,0x06]，位于 zip 末尾 22 字节（无注释）的起始
const eocd = zip.length - 22;
check(
  '尾部是 EOCD 签名 PK\\x05\\x06',
  zip[eocd] === 0x50 && zip[eocd + 1] === 0x4b && zip[eocd + 2] === 0x05 && zip[eocd + 3] === 0x06,
);
// 字节数等于两文件 + 头尾，粗略下界
check('zip 长度合理(> 两文件+200)', zip.length > hello.length + json.length + 200);

writeFileSync('/tmp/sc-zip-test.zip', zip);
console.log(`\nZIP 已写盘: /tmp/sc-zip-test.zip (${zip.length} bytes)`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

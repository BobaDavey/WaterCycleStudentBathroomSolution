import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOrigin, usesSecureCookie } from '../src/lib/request-security';

test('accepts browser authority when the internal server binds to another address', () => {
 assert.equal(isSameOrigin('http://127.0.0.1:3200','127.0.0.1:3200'),true);
 assert.equal(isSameOrigin('http://localhost:3000','localhost:3000'),true);
 assert.equal(isSameOrigin('https://classroom.vercel.app','classroom.vercel.app',true),true);
 assert.equal(isSameOrigin('https://school.example','school.example:443',true),true);
 assert.equal(isSameOrigin('http://[::1]:3000','[::1]:3000'),true);
});
test('rejects mismatched domains, subdomains, and ports', () => {
 assert.equal(isSameOrigin('https://attacker.example','school.example'),false);
 assert.equal(isSameOrigin('https://school.example.attacker.example','school.example'),false);
 assert.equal(isSameOrigin('https://evil.school.example','school.example'),false);
 assert.equal(isSameOrigin('http://localhost:3001','localhost:3000'),false);
 assert.equal(isSameOrigin('http://classroom.vercel.app','classroom.vercel.app',true),false);
});
test('rejects missing, opaque, non-web, and malformed origins and host headers', () => {
 for (const origin of [null,'null','file:///tmp/index.html','data:text/html,test','https://school.example/path','https://school.example/','https://school.example?query=1','https://user:secret@school.example']) {
  assert.equal(isSameOrigin(origin,'school.example'),false, String(origin));
 }
 for (const host of [null,'school.example/','school.example@attacker.example','school.example?query','school.example#hash','school.example,attacker.example',' school.example','school.example\\attacker.example']) {
  assert.equal(isSameOrigin('https://school.example',host),false,String(host));
 }
});
test('marks cookies secure for HTTPS browser origins behind a proxy and Vercel', () => {
 assert.equal(usesSecureCookie('https://school.example','http:'),true);
 assert.equal(usesSecureCookie(null,'https:'),true);
 assert.equal(usesSecureCookie('http://localhost:3000','http:',true),true);
 assert.equal(usesSecureCookie('http://localhost:3000','http:'),false);
 assert.equal(usesSecureCookie(null,'http:'),false);
});

// Makes a VAPID key pair for Web Push (phase 7b). Run once per Supabase project, from Ping/tests:
//   node make-vapid.mjs
// The PUBLIC key goes into index.html (ACCT_PROJECTS → `vapid`) and into the Edge Function secret VAPID_PUBLIC_KEY.
// The PRIVATE key goes ONLY into the Edge Function secret VAPID_PRIVATE_KEY (and your password manager). Never commit it.
// A cron secret for PUSH_CRON_SECRET / Vault push_cron_secret is printed too.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const b64u = b => Buffer.from(b).toString('base64url');
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
console.log('VAPID_PUBLIC_KEY  =', b64u(pub));
console.log('VAPID_PRIVATE_KEY =', jwk.d);
console.log('PUSH_CRON_SECRET  =', b64u(crypto.getRandomValues(new Uint8Array(32))));

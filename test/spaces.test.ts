// Spaces and messages, end to end through the HTTP API. Fixture people only; envelopes are test bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedTestAreas, type TestApp, type Person } from './helpers.ts';

let app: TestApp;
before(async () => { app = await startApp(); await seedTestAreas(app.db); });
after(async () => { await app.close(); });

const b64 = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64');
const dmSealed = () => ({ v: 1, iv: b64(12), ct: b64(64) });
const spaceSealed = (ids: string[]) => ({ ...dmSealed(), keys: Object.fromEntries(ids.map((id) => [id, b64(40)])) });

let n = 0;
async function makeSpace(owner: Person, extra: Record<string, unknown> = {}): Promise<{ slug: string; id: string; chat: string }> {
  n++;
  const slug = `test-space-${n}`;
  const r = await owner.call('POST', '/spaces', { name: `Test Space ${n}`, slug, kind: 'crew', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const got = await owner.call('GET', `/spaces/${slug}`);
  return { slug, id: r.body.space.id, chat: got.body.channels[0].id };
}

test('create a Space: creator is owner, a chat channel is made, the address is unique', async () => {
  const a = await app.person();
  const r = await a.call('POST', '/spaces', { name: 'Riders of Test City', slug: 'riders-test', kind: 'trade', area_code: 'T-CITY', about: 'Fixture' });
  assert.equal(r.status, 201);
  assert.equal(r.body.space.visibility, 'public');
  assert.deepEqual(r.body.space.area, { code: 'T-CITY', name: 'Test City' });
  assert.equal(r.body.space.members, 1);
  const g = await a.call('GET', '/spaces/riders-test');
  assert.equal(g.body.my_role, 'owner');
  assert.deepEqual(g.body.channels.map((c: { name: string }) => c.name), ['chat']);
  assert.equal(g.body.members_count, 1);
  assert.equal(g.body.faces[0].handle, a.handle);
  assert.ok(g.body.as_of);
  assert.equal((await a.call('POST', '/spaces', { name: 'Again', slug: 'riders-test', kind: 'trade' })).status, 409);
  assert.equal((await a.call('POST', '/spaces', { name: 'Bad', slug: 'Bad Slug!', kind: 'trade' })).status, 400);
  assert.equal((await a.call('POST', '/spaces', { name: 'Bad kind', slug: 'bad-kind', kind: 'club' })).status, 400);
  assert.equal((await a.call('POST', '/spaces', { name: 'Nowhere', slug: 'nowhere', kind: 'crew', area_code: 'NOPE' })).status, 400);
  assert.equal((await app.call('POST', '/spaces', { name: 'Anon', slug: 'anon-space', kind: 'crew' })).status, 401);
  // listed for everyone, with live member counts; near and search find it
  const list = await app.call('GET', '/spaces?near=T-REG');
  assert.ok(list.body.spaces.some((s: { slug: string }) => s.slug === 'riders-test'));
  assert.ok(list.body.as_of);
  assert.ok((await app.call('GET', '/spaces?q=riders')).body.spaces.some((s: { slug: string }) => s.slug === 'riders-test'));
  assert.ok(!(await app.call('GET', '/spaces?near=T-CITY2')).body.spaces.some((s: { slug: string }) => s.slug === 'riders-test'));
});

test('roles: owner > moderator > member; only the owner changes roles', async () => {
  const owner = await app.person(), mod = await app.person(), mem = await app.person();
  const s = await makeSpace(owner);
  assert.equal((await mod.call('POST', `/spaces/${s.slug}/members`)).status, 204);
  assert.equal((await mem.call('POST', `/spaces/${s.slug}/members`)).status, 204);
  assert.equal((await mem.call('POST', `/spaces/${s.slug}/members`)).status, 204, 'joining twice is fine');

  // a member cannot edit, make channels or change roles
  assert.equal((await mem.call('PATCH', `/spaces/${s.slug}`, { about: 'mine now' })).status, 403);
  assert.equal((await mem.call('POST', `/spaces/${s.slug}/channels`, { name: 'jobs' })).status, 403);
  assert.equal((await mem.call('PATCH', `/spaces/${s.slug}/members/${mod.handle}`, { role: 'moderator' })).status, 403);

  assert.equal((await owner.call('PATCH', `/spaces/${s.slug}/members/${mod.handle}`, { role: 'moderator' })).status, 204);
  assert.equal((await owner.call('PATCH', `/spaces/${s.slug}/members/${mod.handle}`, { role: 'king' })).status, 400);

  // a moderator edits and makes channels, but cannot change roles
  const up = await mod.call('PATCH', `/spaces/${s.slug}`, { about: 'Rules are public', rules: 'Be kind' });
  assert.equal(up.status, 200);
  assert.equal(up.body.space.rules, 'Be kind');
  const ch = await mod.call('POST', `/spaces/${s.slug}/channels`, { name: 'jobs' });
  assert.equal(ch.status, 201);
  assert.equal(ch.body.channel.position, 1);
  assert.equal((await mod.call('POST', `/spaces/${s.slug}/channels`, { name: 'jobs' })).status, 409);
  assert.equal((await mod.call('PATCH', `/spaces/${s.slug}/members/${mem.handle}`, { role: 'moderator' })).status, 403);
  // visibility and address never change
  assert.equal((await owner.call('PATCH', `/spaces/${s.slug}`, { visibility: 'private' })).body.error.code, 'fixed');

  // removing: moderators remove members, never owners
  assert.equal((await mod.call('DELETE', `/spaces/${s.slug}/members`, { handle: owner.handle })).status, 403);
  assert.equal((await mod.call('DELETE', `/spaces/${s.slug}/members`, { handle: mem.handle })).status, 204);
  const members = await owner.call('GET', `/spaces/${s.slug}/members`);
  assert.deepEqual(members.body.members.map((m: { person: { handle: string } }) => m.person.handle).sort(), [owner.handle, mod.handle].sort());
  assert.equal(members.body.members.find((m: { role: string; person: { handle: string } }) => m.person.handle === mod.handle).role, 'moderator');

  // the last owner cannot leave or step down; after handing over they can
  assert.equal((await owner.call('DELETE', `/spaces/${s.slug}/members`)).body.error.code, 'last_owner');
  assert.equal((await owner.call('PATCH', `/spaces/${s.slug}/members/${owner.handle}`, { role: 'member' })).body.error.code, 'last_owner');
  assert.equal((await owner.call('PATCH', `/spaces/${s.slug}/members/${mod.handle}`, { role: 'owner' })).status, 204);
  assert.equal((await owner.call('DELETE', `/spaces/${s.slug}/members`)).status, 204);
  assert.equal((await owner.call('GET', `/spaces/${s.slug}`)).body.my_role, null);
});

test('public Space chat: members send plaintext, sealed is refused, non-members cannot send', async () => {
  const owner = await app.person(), outsider = await app.person();
  const s = await makeSpace(owner);
  const sent = await owner.call('POST', `/channels/${s.chat}/messages`, { body: 'Magandang umaga' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, 'Magandang umaga');
  assert.equal(sent.body.message.sealed, null);
  assert.equal(sent.body.message.author.handle, owner.handle);
  assert.equal((await owner.call('POST', `/channels/${s.chat}/messages`, { sealed: dmSealed() })).body.error.code, 'plaintext_only');
  assert.equal((await outsider.call('POST', `/channels/${s.chat}/messages`, { body: 'hi' })).status, 403);
  const read = await outsider.call('GET', `/channels/${s.chat}/messages`);
  assert.equal(read.status, 200);
  assert.equal(read.body.messages[0].body, 'Magandang umaga');
  assert.ok(read.body.as_of);
});

test('private Space: invite only, and invisible (404, not 403) to non-members', async () => {
  const owner = await app.person(), member = await app.person(), outsider = await app.person();
  const s = await makeSpace(owner, { visibility: 'private', name: 'Secret Crew Fixture' });
  const missing = await outsider.call('GET', '/spaces/no-such-space');
  const hidden = await outsider.call('GET', `/spaces/${s.slug}`);
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body, 'a private Space looks exactly like one that does not exist');
  assert.equal((await app.call('GET', `/spaces/${s.slug}`)).status, 404);
  for (const [m, p] of [['GET', `/spaces/${s.slug}/members`], ['GET', `/spaces/${s.slug}/posts`], ['POST', `/spaces/${s.slug}/members`],
    ['GET', `/channels/${s.chat}/messages`], ['POST', `/channels/${s.chat}/messages`], ['PATCH', `/spaces/${s.slug}`], ['POST', `/spaces/${s.slug}/read`]] as const) {
    assert.equal((await outsider.call(m, p, m === 'GET' ? undefined : {})).status, 404, `${m} ${p}`);
  }
  assert.ok(!(await outsider.call('GET', '/spaces?q=secret')).body.spaces.some((x: { slug: string }) => x.slug === s.slug));
  assert.ok(!(await app.call('GET', '/spaces')).body.spaces.some((x: { slug: string }) => x.slug === s.slug));

  // the owner invites by handle; then the member sees it, but a plain member cannot invite
  assert.equal((await owner.call('POST', `/spaces/${s.slug}/members`, { handle: member.handle })).status, 204);
  assert.equal((await owner.call('POST', `/spaces/${s.slug}/members`, { handle: 'no.such.person' })).status, 404);
  assert.equal((await member.call('GET', `/spaces/${s.slug}`)).body.my_role, 'member');
  assert.equal((await member.call('POST', `/spaces/${s.slug}/members`, { handle: outsider.handle })).status, 403);
  assert.ok((await member.call('GET', '/spaces?mine=1')).body.spaces.some((x: { slug: string }) => x.slug === s.slug));
});

test('private Space messages: plaintext refused, sealed for members only, each sees only their key', async () => {
  const owner = await app.person(), member = await app.person(), outsider = await app.person();
  const s = await makeSpace(owner, { visibility: 'private' });
  await owner.call('POST', `/spaces/${s.slug}/members`, { handle: member.handle });
  const url = `/channels/${s.chat}/messages`;
  assert.equal((await owner.call('POST', url, { body: 'plain words' })).body.error.code, 'sealed_only');
  assert.equal((await owner.call('POST', url, { body: 'plain', sealed: spaceSealed([owner.id, member.id]) })).body.error.code, 'sealed_only');
  assert.equal((await owner.call('POST', url, {})).body.error.code, 'sealed_only');

  const ok = await owner.call('POST', url, { sealed: spaceSealed([owner.id, member.id]) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.message.body, null);
  const list = await member.call('GET', url);
  const m = list.body.messages[0];
  assert.equal(m.body, null);
  assert.deepEqual(Object.keys(m.sealed.keys), [member.id], 'a member receives only their own wrapped key');
  assert.ok('dm_public_key' in m.author, 'the author\'s public key comes with the message, to unwrap the key');
  assert.ok((await member.call('GET', `/spaces/${s.slug}/members`)).body.members.every((x: { person: object }) => 'dm_public_key' in x.person));
  assert.equal(m.sealed.iv, ok.body.message.sealed.iv);
  const stored = await app.db.one<{ body: string | null; sealed: { keys: object } }>('SELECT body, sealed FROM messages WHERE id = $1', [ok.body.message.id]);
  assert.equal(stored!.body, null);
  assert.equal(Object.keys(stored!.sealed.keys).length, 2);

  // keys: only current members, always including the sender
  assert.equal((await owner.call('POST', url, { sealed: spaceSealed([owner.id, outsider.id]) })).status, 400);
  assert.equal((await owner.call('POST', url, { sealed: spaceSealed([member.id]) })).status, 400);
  assert.equal((await owner.call('POST', url, { sealed: dmSealed() })).status, 400, 'private Space envelope needs keys');
  assert.equal((await owner.call('POST', url, { sealed: { ...spaceSealed([owner.id]), keys: { [owner.id]: b64(513) } } })).status, 400);
  assert.equal((await owner.call('POST', url, { sealed: { ...spaceSealed([owner.id]), keys: { 'not-a-uuid': b64(40) } } })).status, 400);
});

test('envelope validation is strict', async () => {
  const a = await app.person(), b = await app.person();
  const conv = (await a.call('POST', '/conversations', { handle: b.handle })).body.conversation;
  const url = `/conversations/${conv.id}/messages`;
  const bad = [
    'plain text',
    null,
    [1, 2],
    { v: 2, iv: b64(12), ct: b64(64) },
    { v: 1, iv: b64(16), ct: b64(64) },
    { v: 1, iv: 'not base64!!', ct: b64(64) },
    { v: 1, iv: b64(12), ct: b64(16) },
    { v: 1, iv: b64(12), ct: b64(8193) },
    { v: 1, iv: b64(12), ct: b64(64).replace(/=+$/, '') + '@' },
    { v: 1, iv: b64(12), ct: b64(64), text: 'leaked plaintext' },
    { v: 1, iv: b64(12), ct: b64(64), keys: { [a.id]: b64(40) } },
  ];
  for (const sealed of bad) {
    const r = await a.call('POST', url, { sealed });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(sealed).slice(0, 60)}`);
  }
  assert.equal((await a.call('POST', url, { v: 1, iv: b64(12), ct: b64(64) })).body.error.code, 'sealed_only');
  assert.equal((await a.call('POST', url, { body: 'hello' })).body.error.code, 'sealed_only');
  assert.equal((await a.call('POST', url, { sealed: { v: 1, iv: b64(12), ct: b64(8192) } })).status, 201, 'exactly 8 KB is fine');
  const count = await app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM dm_messages WHERE conversation_id = $1', [conv.id]);
  assert.equal(count!.n, 1, 'nothing refused was stored');
});

test('DMs: a stranger lands in Requests until accepted; a follower is accepted at once', async () => {
  const a = await app.person(), b = await app.person(), c = await app.person();
  await b.call('PATCH', '/me', { dm_public_key: { kty: 'EC', crv: 'P-256', x: b64(32).replace(/=/g, ''), y: b64(32, 9).replace(/=/g, '') } });
  const made = await a.call('POST', '/conversations', { handle: b.handle });
  assert.equal(made.status, 201);
  const conv = made.body.conversation;
  assert.equal(conv.accepted, false);
  assert.equal(conv.started_by_me, true);
  assert.equal(conv.other.handle, b.handle);
  assert.equal(conv.other.dm_public_key.crv, 'P-256', 'the browser needs the other person\'s public key');
  assert.equal((await a.call('POST', '/conversations', { handle: b.handle })).status, 200, 'existing conversation returned');
  assert.equal((await a.call('POST', '/conversations', { handle: a.handle })).status, 400);

  // A sees it in their list; B sees it only under Requests
  assert.ok((await a.call('GET', '/conversations')).body.conversations.some((x: { id: string }) => x.id === conv.id));
  assert.ok(!(await b.call('GET', '/conversations')).body.conversations.some((x: { id: string }) => x.id === conv.id));
  const reqs = await b.call('GET', '/conversations?requests=1');
  assert.ok(reqs.body.as_of);
  assert.ok(reqs.body.conversations.some((x: { id: string }) => x.id === conv.id));
  assert.equal((await a.call('GET', '/conversations?requests=1')).body.conversations.length, 0);

  // a stranger may send a few messages before acceptance, no more
  for (let i = 0; i < 3; i++) assert.equal((await a.call('POST', `/conversations/${conv.id}/messages`, { sealed: dmSealed() })).status, 201);
  assert.equal((await a.call('POST', `/conversations/${conv.id}/messages`, { sealed: dmSealed() })).body.error.code, 'request_pending');

  // outsiders cannot see it; the starter cannot accept their own request
  assert.equal((await c.call('GET', `/conversations/${conv.id}/messages`)).status, 404);
  assert.equal((await c.call('POST', `/conversations/${conv.id}/accept`)).status, 404);
  assert.equal((await a.call('POST', `/conversations/${conv.id}/accept`)).status, 403);
  assert.equal((await b.call('POST', `/conversations/${conv.id}/accept`)).status, 204);
  assert.ok((await b.call('GET', '/conversations')).body.conversations.some((x: { id: string; accepted: boolean }) => x.id === conv.id && x.accepted));
  assert.equal((await a.call('POST', `/conversations/${conv.id}/messages`, { sealed: dmSealed() })).status, 201);

  // someone who follows you gets an accepted conversation straight away
  await c.call('POST', `/people/${a.handle}/follow`);
  const fromA = await a.call('POST', '/conversations', { handle: c.handle });
  assert.equal(fromA.body.conversation.accepted, true);
});

test('unread: Space unread uses last_read_at and POST /read; DM unread clears on reading', async () => {
  const owner = await app.person(), member = await app.person();
  const s = await makeSpace(owner);
  await member.call('POST', `/spaces/${s.slug}/members`);
  await owner.call('POST', `/channels/${s.chat}/messages`, { body: 'one' });
  await owner.call('POST', `/channels/${s.chat}/messages`, { body: 'two' });
  const mine = await member.call('GET', '/spaces?mine=1');
  const row = mine.body.spaces.find((x: { slug: string }) => x.slug === s.slug);
  assert.equal(row.unread, 2);
  assert.equal(row.role, 'member');
  assert.equal(row.last_message.body, 'two');
  assert.equal((await member.call('GET', `/spaces/${s.slug}`)).body.channels[0].unread, 2);
  assert.equal((await owner.call('GET', '/spaces?mine=1')).body.spaces.find((x: { slug: string }) => x.slug === s.slug).unread, 0, 'your own messages are not unread');
  assert.equal((await member.call('POST', `/spaces/${s.slug}/read`)).status, 204);
  assert.equal((await member.call('GET', '/spaces?mine=1')).body.spaces.find((x: { slug: string }) => x.slug === s.slug).unread, 0);
  const stranger = await app.person();
  assert.equal((await stranger.call('POST', `/spaces/${s.slug}/read`)).status, 403);

  const conv = (await owner.call('POST', '/conversations', { handle: member.handle })).body.conversation;
  await owner.call('POST', `/conversations/${conv.id}/messages`, { sealed: dmSealed() });
  const before = (await member.call('GET', '/conversations?requests=1')).body.conversations.find((x: { id: string }) => x.id === conv.id);
  assert.equal(before.unread, 1);
  const msgs = await member.call('GET', `/conversations/${conv.id}/messages`);
  assert.equal(msgs.body.messages.length, 1);
  assert.equal(msgs.body.messages[0].sender_id, owner.id);
  assert.deepEqual(Object.keys(msgs.body.messages[0].sealed).sort(), ['ct', 'iv', 'v']);
  const after = (await member.call('GET', '/conversations?requests=1')).body.conversations.find((x: { id: string }) => x.id === conv.id);
  assert.equal(after.unread, 0);
});

test('Space posts: newest first, members only for a private Space', async () => {
  const owner = await app.person(), outsider = await app.person();
  const pub = await makeSpace(owner);
  const priv = await makeSpace(owner, { visibility: 'private' });
  // posts are written by the posts module; insert fixture rows directly
  await app.db.query(`INSERT INTO posts (author_id, body, space_id, created_at) VALUES ($1, 'older fixture post', $2, now() - interval '1 hour'), ($1, 'newer fixture post', $2, now())`, [owner.id, pub.id]);
  await app.db.query(`INSERT INTO posts (author_id, body, space_id) VALUES ($1, 'members only fixture', $2)`, [owner.id, priv.id]);
  const r = await outsider.call('GET', `/spaces/${pub.slug}/posts`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.posts.map((p: { body: string }) => p.body), ['newer fixture post', 'older fixture post']);
  assert.equal(r.body.posts[0].author.handle, owner.handle);
  assert.equal(r.body.end, true);
  assert.ok(r.body.as_of);
  assert.equal((await outsider.call('GET', `/spaces/${priv.slug}/posts`)).status, 404);
  assert.equal((await owner.call('GET', `/spaces/${priv.slug}/posts`)).body.posts.length, 1);
});

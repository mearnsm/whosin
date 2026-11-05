// Who's in? API. One Netlify Function serving everything under /api/.
//
// Data lives in Netlify Blobs (store "whosin"):
//   g/<groupId>             group: name, threshold, password hash, locked-in plan
//   m/<groupId>/<memberId>  member: nick, free nights, RSVPs, hashed device tokens
// Each member is its own blob, so two people marking nights at once never
// overwrite each other.

import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const config = { path: "/api/*" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_MEMBERS = 50;

const store = () => getStore({ name: "whosin", consistency: "strong" });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);
const newId = (bytes = 9) => randomBytes(bytes).toString("base64url");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hashPassword = (pw, salt) => scryptSync(pw, salt, 32).toString("hex");
const clean = (s, max) =>
  typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, max) : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Keep a couple of days of history so time zones never trim tonight.
const cutoff = () => new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function getMembers(s, gid) {
  const { blobs } = await s.list({ prefix: `m/${gid}/` });
  const all = await Promise.all(
    blobs.map(async (b) => {
      const m = await s.get(b.key, { type: "json" });
      return m ? { id: b.key.split("/").pop(), ...m } : null;
    })
  );
  return all.filter(Boolean);
}

async function authenticate(req, s, gid) {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match || !ID.test(match[1])) return null;
  const mid = match[1];
  const mem = await s.get(`m/${gid}/${mid}`, { type: "json" });
  if (!mem || !(mem.tokens || []).includes(sha(match[2]))) return null;
  return { mid, mem };
}

// Each device gets its own token; keep the most recent few.
function issueToken(mem) {
  const token = newId(24);
  mem.tokens = [...(mem.tokens || []), sha(token)].slice(-8);
  return token;
}

function cleanDays(days) {
  const out = {};
  const c = cutoff();
  if (days && typeof days === "object") {
    for (const [k, v] of Object.entries(days)) {
      if (DATE.test(k) && k >= c && v === "free") out[k] = "free";
      if (Object.keys(out).length >= 150) break;
    }
  }
  return out;
}

const publicMember = (m) => ({ id: m.id, nick: m.nick, days: m.days || {}, rsvp: m.rsvp || {} });

async function createGroup(req, s) {
  const b = await readBody(req);
  const name = clean(b.name, 40);
  const nick = clean(b.nick, 24);
  const password = typeof b.password === "string" ? b.password : "";
  const threshold = Math.min(20, Math.max(2, parseInt(b.threshold, 10) || 4));
  if (!name) return fail(400, "Give the group a name.");
  if (password.length < 4) return fail(400, "Pick a password of at least 4 characters.");
  if (password.length > 100) return fail(400, "That password is too long.");
  if (!nick) return fail(400, "Add the name your mates know you by.");

  const gid = newId();
  const salt = newId(16);
  await s.setJSON(`g/${gid}`, {
    name,
    threshold,
    salt,
    hash: hashPassword(password, salt),
    plan: null,
    createdAt: Date.now(),
  });
  const mid = newId();
  const mem = { nick, days: {}, rsvp: {}, tokens: [], joinedAt: Date.now(), updatedAt: Date.now() };
  const token = issueToken(mem);
  await s.setJSON(`m/${gid}/${mid}`, mem);
  return json({ groupId: gid, memberId: mid, token, name });
}

async function join(req, s, gid, g) {
  const b = await readBody(req);
  const password = typeof b.password === "string" ? b.password.slice(0, 100) : "";
  const nick = clean(b.nick, 24);
  const given = Buffer.from(hashPassword(password, g.salt), "hex");
  const stored = Buffer.from(g.hash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    await sleep(700); // slow down guessing
    return fail(403, "That password isn't right.");
  }
  if (!nick) return fail(400, "Add the name your mates know you by.");

  const members = await getMembers(s, gid);
  // Same name again (e.g. a new phone) picks up that person's existing nights.
  const existing = members.find((m) => m.nick.toLowerCase() === nick.toLowerCase());
  let mid, mem;
  if (existing) {
    ({ id: mid, ...mem } = existing);
  } else {
    if (members.length >= MAX_MEMBERS) return fail(400, "This group is full.");
    mid = newId();
    mem = { nick, days: {}, rsvp: {}, tokens: [], joinedAt: Date.now() };
  }
  const token = issueToken(mem);
  mem.updatedAt = Date.now();
  await s.setJSON(`m/${gid}/${mid}`, mem);
  return json({ memberId: mid, token, name: g.name });
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const s = store();

  try {
    if (parts[0] !== "groups") return fail(404, "Not found");
    if (parts.length === 1 && method === "POST") return await createGroup(req, s);

    const gid = parts[1];
    if (!ID.test(gid || "")) return fail(404, "Group not found");
    const g = await s.get(`g/${gid}`, { type: "json" });
    if (!g) return fail(404, "Group not found");
    const sub = parts[2] || "";

    if (sub === "info" && method === "GET") return json({ name: g.name });
    if (sub === "join" && method === "POST") return await join(req, s, gid, g);

    const me = await authenticate(req, s, gid);
    if (!me) return fail(401, "Please join the group again.");

    if (!sub && method === "GET") {
      const members = await getMembers(s, gid);
      return json({
        group: { id: gid, name: g.name, threshold: g.threshold, plan: g.plan || null },
        members: members.map(publicMember),
      });
    }

    if (sub === "me" && method === "PUT") {
      const b = await readBody(req);
      const mem = me.mem;
      if ("nick" in b) {
        const nick = clean(b.nick, 24);
        if (!nick) return fail(400, "Add the name your mates know you by.");
        mem.nick = nick;
      }
      if ("days" in b) mem.days = cleanDays(b.days);
      if (b.rsvp && typeof b.rsvp === "object") {
        mem.rsvp = mem.rsvp || {};
        for (const [k, v] of Object.entries(b.rsvp)) {
          if (!DATE.test(k)) continue;
          if (v === "in" || v === "out") mem.rsvp[k] = v;
          else delete mem.rsvp[k];
        }
        const c = cutoff();
        for (const k of Object.keys(mem.rsvp)) if (k < c) delete mem.rsvp[k];
      }
      mem.updatedAt = Date.now();
      await s.setJSON(`m/${gid}/${me.mid}`, mem);
      return json({ ok: true });
    }

    if (sub === "me" && method === "DELETE") {
      await s.delete(`m/${gid}/${me.mid}`);
      return json({ ok: true });
    }

    if (sub === "plan" && method === "PUT") {
      const b = await readBody(req);
      if (b.date === null) {
        g.plan = null;
      } else if (DATE.test(b.date || "")) {
        g.plan = { date: b.date, by: me.mid, at: Date.now() };
        me.mem.rsvp = { ...(me.mem.rsvp || {}), [b.date]: "in" };
        await s.setJSON(`m/${gid}/${me.mid}`, me.mem);
      } else {
        return fail(400, "That date doesn't look right.");
      }
      await s.setJSON(`g/${gid}`, g);
      return json({ ok: true });
    }

    return fail(404, "Not found");
  } catch (err) {
    console.error(err);
    return fail(500, "Something went wrong on the server.");
  }
};

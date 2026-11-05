# Who's in?

Find the night your mates are all free. Start a group, send your mates the invite link and the group password, and everyone taps the nights they're free. When enough of you can make the same night, it lights up green and you can lock it in.

## How it's built

- `public/index.html`: the whole app (one page, no build step).
- `netlify/functions/api.mjs`: a small API at `/api/...` that checks group passwords and saves everyone's nights.
- Data is kept in Netlify Blobs (store name `whosin`), so there's no separate database to set up.

## Putting it on Netlify

1. In Netlify, choose **Add new site → Import an existing project → GitHub**, and pick this repository.
2. Leave the build settings as Netlify fills them in from `netlify.toml` (publish directory `public`, no build command needed) and click **Deploy**.
3. When it's live, open the site, tap **Start a group**, and set a group password.
4. Tap **Invite mates** to share the link, and send them the password separately.

Every push to the main branch redeploys the site automatically.

## Good to know

- The group password keeps strangers out, but it isn't strong security: anyone who has it can join, and people pick their own names.
- Each phone remembers who you are after you join. On a new phone, join again with the same name to pick up your nights.
- Past nights are tidied away automatically.

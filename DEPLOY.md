# Deploying to the Synology NAS

The app runs as one small container on the DS920+. Cloudflare Access handles
sign-in at `vocab.actnaturally.online`, and the server checks Access's signed
token on every request, so only the people you allow can save progress.

Do the steps in this order: the Access application goes in **before** the
public hostname, so the site is never reachable without a login.

## 1. Put the files on the NAS

Pick one:

- **Git** (easier to update): SSH into the NAS, then
  ```sh
  cd /volume1/docker
  git clone https://github.com/jason-patterson/vocab-flashcards.git
  ```
- **No git**: on GitHub, click **Code > Download ZIP**, then unzip it in
  File Station to `/volume1/docker/vocab-flashcards`.

## 2. Create the Access application

In the Cloudflare dashboard, open **Zero Trust**.

1. **Access > Applications > Add an application > Self-hosted**.
2. **Application name**: Vocab Flashcards.
   **Session duration**: 1 month, so nobody has to sign in every day.
3. **Domain**: subdomain `vocab`, domain `actnaturally.online`.
4. **Add a policy**: name it "Family", action **Allow**, then
   **Include > Emails**, and add the four addresses (yours, Max's, his mom's,
   his cousin's).
5. **Login methods**: One-time PIN is on by default and is enough (a code is
   emailed). You can also add Google.
6. Save. Open the application again and copy its
   **Application Audience (AUD) Tag**.
7. Under **Settings > Custom Pages** (or **Settings > General**), note your
   **team domain**, which looks like `yourteam.cloudflareaccess.com`.

## 3. Fill in the settings

In the folder on the NAS, copy `.env.example` to `.env` and set:

```ini
CF_TEAM_DOMAIN=yourteam.cloudflareaccess.com
CF_ACCESS_AUD=<the AUD tag from step 2>
ALLOWED_EMAILS=<the same four emails, comma-separated>   # optional second check
LEARNED_STREAK=2
```

## 4. Start the container

The container joins a shared Docker network called `cloudflared`, which the
NAS's tunnel connector (`cloudflared-ds920`) is also on. Create it once over SSH:

```sh
sudo docker network create cloudflared
```

Then **Container Manager > Project > Create**:

- **Project name**: `vocab-flashcards`
- **Path**: `/volume1/docker/vocab-flashcards`
- **Source**: use the existing `docker-compose.yml`
- Click **Next > Done**. It downloads `node:20-alpine` and starts.

Check it: the container's logs should show
`Vocab flashcards on port 8787, learned after 2 in a row`, and its status
should turn **healthy** after a minute. No port is opened on the NAS; only
containers on the `cloudflared` network can reach it.

## 5. Add the route to the DS920+ tunnel

**Zero Trust > Networks > Tunnels > DS920+ > Routes > Add**:

- **Subdomain**: `vocab`  **Domain**: `actnaturally.online`
- **Service URL**: `http://vocab-flashcards:8787`

## 6. Test it

1. Open `https://vocab.actnaturally.online`, enter your email, then the code.
2. Under the card it should say **Signed in as you@…**. If it says
   "Progress is saved on this device only", the page couldn't reach the
   server (see Troubleshooting).
3. Answer a few cards, reload the page, and check that the day picker shows
   the progress.

**On each iPhone and iPad:** open the address in Safari and sign in, then use
Share > **Add to Home Screen**. The home-screen app keeps its own cookies on
iOS, so sign in once more inside it. After that it stays signed in for a month.

## Updating

- **Words or the page** (`index.html`): `git pull` in the folder, or replace
  the file. No restart needed; the next page load picks it up.
- **The server** (`server.js` or `docker-compose.yml`): pull or replace, then
  **Container Manager > Project > vocab-flashcards > Action > Restart**.

## Backups

All progress is in `data/progress.json`. Include `/volume1/docker` in your
Hyper Backup task and it's covered.

## Troubleshooting

Check the container's logs, and open `https://vocab.actnaturally.online/api/progress`
in a browser. The error message names what's wrong:

| Message | Fix |
|---|---|
| `wrong audience` | `CF_ACCESS_AUD` doesn't match the application's AUD tag |
| `wrong issuer` or `certs fetch failed` | `CF_TEAM_DOMAIN` is wrong (no `https://`, no trailing slash) |
| `malformed token` | The request didn't come through Access. Check that the hostname is covered by the Access application |
| `not allowed` | The email isn't in `ALLOWED_EMAILS` |
| Container exits at start | `.env` is missing `CF_TEAM_DOMAIN` or `CF_ACCESS_AUD` |

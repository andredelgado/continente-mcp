# Configuration

Settings come from environment variables and an optional private credentials file. They are
read when the server starts, and one server process serves one account. The Claude Desktop
extension asks for your email and password when you install it (both optional: without them,
search and product details still work) and passes them to the server for you; the rest of this
page is for manual setups.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTINENTE_EMAIL` | — | Account email, used for automatic sign-in. Not needed for search or product details. |
| `CONTINENTE_PASSWORD` | — | Account password. |
| `CONTINENTE_CREDENTIALS_FILE` | `<data dir>/credentials.env` | Location of the credentials file. Set this in the MCP client configuration. |
| `CONTINENTE_DATA_DIR` | `~/.continentept-mcp` | Directory for the saved session, the favorites snapshot and, by default, the credentials file. |
| `CONTINENTE_BROWSER_IDLE_SECONDS` | `300` | Close the browser after this many idle seconds. `0` keeps it open until the server stops. |
| `CONTINENTE_UPDATE_CHECK` | `1` | Set to `0` to stop the daily check for a newer release on npm. |
| `CONTINENTE_SIGN_IN_WINDOW` | `1` | Set to `0` so the server never opens a sign-in window when Continente asks you to confirm you are not a robot (see below). |

`~` is your home directory: `HOME`, or `%USERPROFILE%` when `HOME` is not set (the usual case on
Windows).

## Credentials file

Instead of putting your password in the MCP client configuration, store it in a private
file, by default `~/.continentept-mcp/credentials.env`:

```sh
CONTINENTE_EMAIL=you@example.com
CONTINENTE_PASSWORD=your-password
```

One `KEY=value` per line. Quotes around a value are removed, `export ` prefixes and `#`
comment lines are allowed, and nothing is expanded. The file may set `CONTINENTE_EMAIL`,
`CONTINENTE_PASSWORD`, `CONTINENTE_BROWSER_IDLE_SECONDS` and `CONTINENTE_UPDATE_CHECK`; other
keys are ignored. A variable set in the environment always wins over the file, even when it
is empty. See [`.env.example`](../.env.example).

Create the file with an editor instead of a command that contains your password, which would
stay in your shell history. Restrict the directory too, since the saved session also grants
access to the account. On macOS and Linux:

```sh
mkdir -p ~/.continentept-mcp && chmod 700 ~/.continentept-mcp
touch ~/.continentept-mcp/credentials.env && chmod 600 ~/.continentept-mcp/credentials.env
${EDITOR:-nano} ~/.continentept-mcp/credentials.env
```

On Windows, in PowerShell. The `icacls` line limits the folder to your user account, and
Notepad offers to create the file:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.continentept-mcp" | Out-Null
icacls "$env:USERPROFILE\.continentept-mcp" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
notepad "$env:USERPROFILE\.continentept-mcp\credentials.env"
```

## Using 1Password

With the [1Password CLI](https://developer.1password.com/docs/cli/get-started/), the
credentials never need to be written to a file. Put secret references in the MCP client
configuration and start the server through `op run`, which swaps them for the real values:

```json
{
  "mcpServers": {
    "continente": {
      "command": "op",
      "args": ["run", "--no-masking", "--", "npx", "-y", "continentept-mcp"],
      "env": {
        "CONTINENTE_EMAIL": "op://Personal/Continente/username",
        "CONTINENTE_PASSWORD": "op://Personal/Continente/password"
      }
    }
  }
}
```

For Claude Code:

```sh
claude mcp add continente \
  -e CONTINENTE_EMAIL=op://Personal/Continente/username \
  -e CONTINENTE_PASSWORD=op://Personal/Continente/password \
  -- op run --no-masking -- npx -y continentept-mcp
```

- Replace `Personal/Continente` with your vault and item. In 1Password, right-click a field
  and choose **Copy Secret Reference** to get the exact reference.
- Turn on **Settings → Developer → Integrate with 1Password CLI** in the 1Password app so
  `op` unlocks with Touch ID or your system password. You are asked when the client starts
  the server.
- Keep `--no-masking`. Without it, `op run` filters the server's output, which carries the MCP
  protocol.
- The same works for the login command:
  `CONTINENTE_EMAIL=op://… CONTINENTE_PASSWORD=op://… op run -- npx -y continentept-mcp login`.

Only the credentials come from 1Password. The website session the server saves after signing
in still lives in the data directory, as described below.

## Sign-in and saved session

Account tools reuse the saved session. When the website reports that it has expired, the
server signs in once with the configured credentials and retries the read. Cart changes are
never retried after they may have been sent.

To sign in ahead of time, or to check your credentials:

```sh
npx -y continentept-mcp login
```

Add `--show-browser` to watch the browser window. If the website asks for extra verification,
complete it in that window; the session is saved once the account is signed in.

This command reads the credentials described on this page: the environment or the credentials
file. It cannot read the email and password stored in the Claude Desktop extension's
settings. If you installed the extension and need this command, create the credentials file
first. The session it saves is the one the extension uses, since both keep it in
`~/.continentept-mcp`.

Sign-in errors are logged as short, fixed messages that name the step that failed. They never
include your password, email or session cookies.

### "Não sou um robô"

Continente can ask you to confirm you are not a robot, a "Não sou um robô" check between the
email and the password. Only you can answer it: the server never ticks it for you.

- When a tool needs to sign in again and meets the check, the server opens a Continente
  sign-in window on your computer with your email filled in, and the tool answers straight
  away that the window is open. Tick "Não sou um robô" and press "Avançar"; the window fills in
  the password from your configured credentials, saves the session and closes. Then ask again.
- Only one window opens at a time. It closes after 5 minutes if you don't finish, and the
  next account request can open a new one.
- No window opens where none can be shown: on Linux without a display (a server, Docker, Home
  Assistant or an SSH session), or with `CONTINENTE_SIGN_IN_WINDOW=0`. The tool's answer then
  tells you to sign in on another computer, as described next.

### Without a screen

Sign in on a computer that has a screen, then move the session to the server:

1. On the computer with a screen, set up the same account's credentials and run
   `npx -y continentept-mcp login --show-browser`. Tick "Não sou um robô" in its window.
2. Copy `session.json` from that computer's data directory (`~/.continentept-mcp`) to the
   server's data directory (`CONTINENTE_DATA_DIR`). [Docker](#docker-build-from-source) below
   shows how to put it in the `/data` volume.

Treat `session.json` like a password while you move it, and delete any copy left on the way.

## Docker (build from source)

The repository has a `Dockerfile` based on the official Playwright image. No image is
published yet, so build it from a checkout. Publishing to `ghcr.io` is planned.

```sh
git clone https://github.com/andredelgado/continente-mcp.git
cd continente-mcp
docker build --tag continente-mcp .
```

The server speaks MCP on stdio, so the client starts the container with `-i`. The image keeps
its data in `/data`; mount a volume there so the session survives between runs:

```json
{
  "mcpServers": {
    "continente": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--init", "--ipc=host",
        "--volume", "continente:/data",
        "--env", "CONTINENTE_EMAIL", "--env", "CONTINENTE_PASSWORD",
        "continente-mcp"],
      "env": {
        "CONTINENTE_EMAIL": "you@example.com",
        "CONTINENTE_PASSWORD": "your-password"
      }
    }
  }
}
```

- `--init` and `--ipc=host` are what Playwright recommends for Chromium in a container: the
  first cleans up finished browser processes, the second gives Chromium enough shared memory.
- `--env NAME` without a value passes the variable through from the client's `env`, so the
  password is not part of the command line. To keep it out of the client configuration too,
  drop both `--env` pairs and mount a credentials file instead:
  `"--volume", "/absolute/path/credentials.env:/data/credentials.env:ro"`. The container runs
  as a non-root user, which must be able to read that file.
- Credentials are never stored in the image.

A container cannot show a sign-in window. When Continente asks for the "Não sou um robô"
check, sign in on a computer with a screen as described [above](#without-a-screen), then copy
its `session.json` into the volume:

```sh
docker run -i --rm --volume continente:/data --entrypoint sh continente-mcp \
  -c 'umask 077 && cat > /data/session.json' < ~/.continentept-mcp/session.json
```

## Stored data

| File in the data directory | Contents |
| --- | --- |
| `session.json` | Website session cookies. Treat it like a password. |
| `favorites.json` | Favorites snapshot, tied to the configured account and current session. |
| `favorites.json.bak` | Previous valid favorites snapshot. |
| `update-check.json` | The latest version seen on npm and when it was checked. |

Files are written atomically. On macOS and Linux they are created readable only by your user;
on Windows they inherit the folder's permissions, so restrict the folder as described above.
The server does not change the permissions of a folder that already exists.

If you sign in with a different account or the saved session is replaced, the old favorites
snapshot is no longer used and the next request fetches a fresh one. A snapshot of the same
account that is more than 24 hours old is still used, marked as stale.

Deleting the data directory removes everything listed above. A credentials file kept
elsewhere (`CONTINENTE_CREDENTIALS_FILE`) and the downloaded Chromium, which lives in
Playwright's own cache folder, are separate.

## Updates

- **Claude Desktop extension:** download the new
  [`continente-mcp.mcpb`](https://github.com/andredelgado/continente-mcp/releases/latest/download/continente-mcp.mcpb)
  and open it. Claude Desktop updates the extension in place and keeps your email and password.
- **npx setups:** write `continentept-mcp@latest` instead of `continentept-mcp` in the client
  configuration; each restart of the client then picks up the newest release. Without
  `@latest`, npx can keep running the version it downloaded first.
- **Release emails:** on [GitHub](https://github.com/andredelgado/continente-mcp), choose
  **Watch → Custom → Releases**.

### Update check

When the server starts, it asks npm for the latest published version, at most once a day and
with a short timeout. The request sends nothing about you or your account. If a newer stable
release exists, the assistant is told about it and `get_session_status` reports it. Nothing is
downloaded or installed automatically. When offline, the check is skipped silently. Set
`CONTINENTE_UPDATE_CHECK=0` to turn it off.

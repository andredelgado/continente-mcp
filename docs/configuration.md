# Configuration

Each server process uses one Continente account. It reads its settings when it starts.
In the Claude Desktop extension you can enter your login in the extension's settings.
For other clients, use a credentials file or environment variables.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTINENTE_EMAIL` | — | Account email, used for automatic sign-in. Not needed for search or product details. |
| `CONTINENTE_PASSWORD` | — | Account password. |
| `CONTINENTE_CREDENTIALS_FILE` | `<data dir>/credentials.env` | Location of the credentials file. Set this in the MCP client configuration. |
| `CONTINENTE_DATA_DIR` | `~/.continentept-mcp` | Directory for the saved session, the favorites snapshot and, by default, the credentials file. |
| `CONTINENTE_BROWSER_IDLE_SECONDS` | `300` | Close the browser after this many idle seconds. `0` keeps it open until the server stops. |
| `CONTINENTE_UPDATE_CHECK` | `1` | Set to `0` to stop the daily check for a newer release on npm. |
| `CONTINENTE_READ_ONLY` | `0` | Added after the 0.16.1 release. Set to `1` (or `true`) to enable [read-only mode](#read-only-mode). |
| `CONTINENTE_SIGN_IN_WINDOW` | `1` | Set to `0` so the server never opens a sign-in window when Continente asks you to confirm you are not a robot (see below). |

`~` is your home directory: `HOME`, or `%USERPROFILE%` when `HOME` is not set (the usual case on
Windows).

## Credentials file

The server reads your email and password from `~/.continentept-mcp/credentials.env` by
default. The file contains your password in plain text. Create it on the machine running
the server and restrict access before entering your details.

**macOS or Linux** — run these commands to open the file in your editor.

```sh
mkdir -p ~/.continentept-mcp && chmod 700 ~/.continentept-mcp
touch ~/.continentept-mcp/credentials.env && chmod 600 ~/.continentept-mcp/credentials.env
${EDITOR:-nano} ~/.continentept-mcp/credentials.env
```

**Windows** — run these commands in PowerShell. They reset existing permissions on the
folder and its contents and grant access to your Windows account. When Notepad opens,
accept its offer to create the file.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.continentept-mcp" | Out-Null
icacls "$env:USERPROFILE\.continentept-mcp" /reset /T /Q | Out-Null
icacls "$env:USERPROFILE\.continentept-mcp" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
notepad "$env:USERPROFILE\.continentept-mcp\credentials.env"
```

Enter these two lines **in the file**, using your own login. Save it and restart the client.
The next time you ask to see your cart, the server uses it to sign in.

```dotenv
CONTINENTE_EMAIL=you@example.com
CONTINENTE_PASSWORD=your-password
```

Use `CONTINENTE_CREDENTIALS_FILE` to choose a different path. The file also accepts
`CONTINENTE_BROWSER_IDLE_SECONDS`, `CONTINENTE_UPDATE_CHECK` and, in versions that support
it, `CONTINENTE_READ_ONLY`. Use one `KEY=value` per line. Surrounding quotes are removed,
`export ` prefixes and `#` comment lines are accepted, and nothing is expanded. Environment
variables take precedence, including empty values. [Example file](../.env.example)

### Interactive setup

The `setup` command was added after the 0.16.1 release. If `npx -y continentept-mcp --help`
lists it, run `npx -y continentept-mcp setup` in a terminal to create the private file and
sign in. It hides your password as you type and preserves other settings in the file.
Use `--no-login` to save without signing in. If you enter the same email as before, pressing
Enter at the password prompt keeps the saved password.

## Read-only mode

Read-only mode was added after the 0.16.1 release. **The published 0.16.1 server still
offers cart and coupon changes even if you set this variable.**

On a version that supports it, `CONTINENTE_READ_ONLY=1` leaves out `add_cart_item`,
`set_cart_item_quantity`, `remove_cart_item`, `clear_cart` and `set_cart_coupons`. You can
still see your cart and coupons and preview a shopping list.

- **Claude Desktop extension:** turn on **Read-only** in the extension's settings, then restart
  Claude Desktop.
- **npx:** add `"CONTINENTE_READ_ONLY": "1"` to the server's `env` in the client configuration,
  or put `CONTINENTE_READ_ONLY=1` in the credentials file.
- **Docker:** add `"--env", "CONTINENTE_READ_ONLY"` to the `args` and `"CONTINENTE_READ_ONLY": "1"`
  to the `env`.

After restarting, check the client's list of Continente tools. A read-only server lists
`get_cart` and `preview_cart_changes` and omits all five change tools above.

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
include your password, email or session cookies. If you turn on Playwright's own debug output
with `DEBUG`, the parts that would record the typed password or the cookies (`pw:api`,
`pw:channel`, `pw:protocol`, `pw:error` and `pw:server*`) stay off. `pw:browser` and
`pw:install` still show how Chromium starts and downloads.

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
   server's data directory (`CONTINENTE_DATA_DIR`). [Docker](#docker) below
   shows how to put it in the `/data` volume.

Treat `session.json` like a password while you move it, and delete any copy left on the way.
The session is tied to the account that signed in: if the server is configured with a different
email, it does not use the copied session and signs in with its own account instead. A session
saved by a version before 0.15 records no account, so a server with an email configured signs in
once to replace it.

## Docker

Releases after 0.15.0 publish an image to `ghcr.io/andredelgado/continente-mcp` for amd64 and
arm64, built on the official Playwright image with the Chromium the server expects. Each release
is tagged with its version (`0.16.0`), its minor version (`0.16`) and `latest`; prereleases get
only their own version tag.

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
        "ghcr.io/andredelgado/continente-mcp:latest"],
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
- Docker's default security profile does not let Chromium start its own sandbox, so in the
  container the browser runs without it and the server logs that once. Outside a container
  the server starts Chromium with its sandbox wherever the system provides it.
- Docker keeps the image it pulled first. Run `docker pull ghcr.io/andredelgado/continente-mcp:latest`
  to update, or write a version tag such as `:0.16.0` to stay on one release.

A container cannot show a sign-in window. When Continente asks for the "Não sou um robô"
check, sign in on a computer with a screen as described [above](#without-a-screen), then copy
its `session.json` into the volume:

```sh
docker run -i --rm --volume continente:/data --entrypoint sh ghcr.io/andredelgado/continente-mcp:latest \
  -c 'umask 077 && cat > /data/session.json' < ~/.continentept-mcp/session.json
```

### Building the image yourself

The `Dockerfile` in the repository builds the same image from a checkout. Use the tag you build
in place of `ghcr.io/andredelgado/continente-mcp:latest` above:

```sh
git clone https://github.com/andredelgado/continente-mcp.git
cd continente-mcp
docker build --tag continente-mcp .
```

## Stored data

| File in the data directory | Contents |
| --- | --- |
| `credentials.env` (optional) | Your sign-in email and password. This is the default location when you use a credentials file. |
| `session.json` | Website session cookies, tied to the account that signed in (by an opaque key, not the email). A server configured with another email does not use it. Treat it like a password. |
| `favorites.json` | Favorites snapshot, tied to the configured account and current session. |
| `favorites.json.bak` | Previous valid favorites snapshot. |
| `update-check.json` | The latest version seen on npm and when it was checked. |

The server writes its session and cache files atomically. On macOS and Linux it creates
them with access limited to your user. On Windows they inherit the folder's permissions.
The [credentials file instructions](#credentials-file) also restrict an existing data folder.

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
- **Docker:** run `docker pull ghcr.io/andredelgado/continente-mcp:latest`, then restart the
  client.
- **Release emails:** on [GitHub](https://github.com/andredelgado/continente-mcp), choose
  **Watch → Custom → Releases**.

### Update check

When the server starts, it asks npm for the latest published version, at most once a day and
with a short timeout. The request sends nothing about you or your account. If a newer stable
release exists, the assistant is told about it and `get_session_status` reports it. Nothing is
downloaded or installed automatically. When offline, the check is skipped silently. Set
`CONTINENTE_UPDATE_CHECK=0` to turn it off.

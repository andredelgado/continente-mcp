# Configuration

Settings come from environment variables and an optional private credentials file. They are
read when the server starts. The Claude Desktop extension asks for your email and password
when you install it and passes them to the server for you; the rest of this page is for
manual setups.

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
`CONTINENTE_PASSWORD`, `CONTINENTE_BROWSER_IDLE_SECONDS` and `CONTINENTE_UPDATE_CHECK`; other keys
are ignored. A variable
set in the environment always wins over the file, even when it is empty. See
[`.env.example`](../.env.example).

Restrict access to the directory, since the saved session also grants access to the account:

```sh
chmod 700 ~/.continentept-mcp
chmod 600 ~/.continentept-mcp/credentials.env
```

On Windows, limit the folder's permissions to your user account.

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

### "Não sou um robô"

Continente can ask you to confirm you are not a robot, a "Não sou um robô" check between the
email and the password. Only you can answer it: the server never ticks it for you.

- When a tool needs to sign in again and meets the check, the server opens a Continente
  sign-in window on your computer with your email filled in, and the tool answers straight
  away that the window is open. Tick "Não sou um robô" and press "Avançar"; the window fills in
  the password from your configured credentials, saves the session and closes. Then ask again.
- Only one window opens at a time. It closes after 5 minutes if you don't finish, and the
  next account request can open a new one.
- No window opens where none can be shown: on Linux without a display (a server, Docker or an
  SSH session), or with `CONTINENTE_SIGN_IN_WINDOW=0`. The tool then says to run
  `continentept-mcp login --show-browser` in a terminal on that computer, which waits for you to
  tick the box in the same way.

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

Sign-in errors are logged as short, fixed messages that name the step that failed. They never
include your password, email or session cookies.

## Update check

When the server starts, it asks npm for the latest published version, at most once a day and
with a short timeout. The request sends nothing about you or your account. If a newer stable
release exists, the assistant is told about it and `get_session_status` reports it. Nothing is
downloaded or installed automatically. When offline, the check is skipped silently. Set
`CONTINENTE_UPDATE_CHECK=0` to turn it off.

One server process serves one account.

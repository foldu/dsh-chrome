# dsh-chrome

My take on a simple electron wrapper for dsh. Can connect to other hosts with dsh web running.
Nothing more really.

---- SLOP LINE -----

## Hosts

The combobox in the titlebar switches between the entries in the app's config
directory, which the settings button edits:

- **`local`** — this machine's `dsh-web` unit, reached through the URL it
  publishes in `$XDG_RUNTIME_DIR/dsh-web/url`.
- **a bare hostname or ssh target** (`jupiter.home.5kw.li`, `barnabas@saturn`, an
  `~/.ssh/config` alias) — the app first asks that host what it is serving, in
  this order: the runtime file the `dsh-web` unit writes
  (`$XDG_RUNTIME_DIR/dsh-web/url`), then `systemctl --user status dsh-web`, then
  `systemctl status dsh` (a saturn-style system unit). `systemctl status` is used
  rather than `journalctl` because it prints only the recent tail, and a source
  whose block does not say the unit is _running_ is skipped — a stopped unit's
  last URL is a dead token. It then starts
  `ssh -N -L <free loopback port>:127.0.0.1:<the port that URL names> <target>`,
  points the URL at the forward's port and loads it. Forwarding is how a remote
  harness is reached: `dsh web` only ever binds its own loopback.
- **a URL** (`https://dsh.home.5kw.li/?token=…`) — loaded as it stands, for a host
  behind a reverse proxy or one carrying its own token.

The forward lives as long as its host is selected: switching away or quitting
takes it down (`ssh` gets a `SIGTERM`, then a `SIGKILL`). ssh runs with
`BatchMode=yes`, so it never waits for a password — the app has no terminal to
answer one — and its first line of complaint is what the waiting screen shows
when a forward cannot come up. Passphraseless keys, or an ssh agent in the app's
environment, are what make this work. The forward targets the port the far side
reported, falling back to 3090 — the one the `dsh-web` unit serves on — when it
reports nothing.

A forward is disposable. When ssh exits — the link drops, a blackholed network
trips `ServerAliveInterval`, the far side's sshd restarts — the window says why
and builds a new one 15 seconds later, re-reading the far side's URL first, so a
harness that restarted meanwhile is picked up with the token it has now. The same
rebuild follows a page that will not load through a forward that is still up, or
a 401 from one: ssh carries bytes whether or not anything is listening behind it,
so neither is visible to ssh itself, and only re-reading the far side gets back
in. Switching hosts and quitting are the cases that do not retry — there the
forward is taken down on purpose.

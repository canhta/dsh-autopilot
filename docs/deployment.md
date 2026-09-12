# One-VPS operation

This is the proposed initial deployment shape for the implemented Host/runtime slice: one systemd-managed DSH Web
profile, one local SQLite runtime store, one target repository and managed worktree root, and operator access through an
SSH local-forward. It deliberately does not configure the unfinished #8 GitHub/Jira publication and delivery providers.

Validation is currently local and synthetic: the packaged Host entry boots in a disposable profile, the unit is checked
with `systemd-analyze verify`, and a separate synthetic process is refused while the first Host owns the same store.
No real VPS shutdown/restart or offline backup/restore drill has been performed. Those steps remain an explicit issue #9
acceptance gate; this recipe must not be presented as production-recovery evidence until that drill is recorded.

The commands below assume a dedicated `dsh-autopilot` system account and these roots:

| Data | Path |
| --- | --- |
| DSH profile, Settings and Session data | `/var/lib/dsh` |
| installed plugin checkout/artifact | `/var/lib/dsh-autopilot/package` |
| Autopilot SQLite runtime store | `/var/lib/dsh-autopilot/runtime/state.sqlite` |
| managed worktrees | `/var/lib/dsh-autopilot/worktrees` |
| target repository, including the worktrees' common Git directory | `/srv/autopilot-target` |
| offline backups | `/var/backups/dsh-autopilot` |

Keep all of these on local durable storage. DSH's SQLite WAL mode is not selected for a network filesystem.

## Install and supervise

Install DSH, Node 24, pnpm and Git through the operator-controlled installation path. Copy the reviewed release artifact to
`/var/lib/dsh-autopilot/package`, create the DSH `autopilot` profile from the Web defaults, and install the artifact:

```sh
sudo -u dsh-autopilot env DSH_HOME=/var/lib/dsh \
  dsh --profile autopilot --from-default-profile web --dump-config >/dev/null
sudo -u dsh-autopilot env DSH_HOME=/var/lib/dsh \
  dsh plugin --profile autopilot add \
  /var/lib/dsh-autopilot/package/canhta-dsh-autopilot-0.1.0-alpha.1.tgz
```

Record the installed DSH version and artifact checksum before promotion. Upgrade either only as a reviewed deployment
change. Autopilot does not install, replace or upgrade the operator's DSH runtime.

In the effective DSH profile, configure the SQLite storage row at
`/var/lib/dsh-autopilot/runtime/state.sqlite`. Autopilot derives persistence and process ownership from that DSH storage
composition. Its optional Host-only `runtimeStorePath` setting is only a fail-closed assertion of the same absolute path;
it neither selects storage nor enables maintenance. Set `managedWorktreeRoot` to `/var/lib/dsh-autopilot/worktrees`,
`targetRepository` to `/srv/autopilot-target`, and the approved target base branch. Select the DSH default Agent preset
and model route for unattended work. Keep execution disabled until those native services and the remaining execution
settings validate and the profile dump shows the intended effective values. The alpha budget fields reconcile
provider-reported usage after requests; they are not an exact cumulative pre-request hard cap. Keep metered production
execution disabled until the enforcement boundary tracked in [#5](https://github.com/canhta/dsh-autopilot/issues/5)
is complete.

Install [the supplied unit](../deploy/dsh-autopilot.service) as `/etc/systemd/system/dsh-autopilot.service`, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-autopilot.service
sudo systemctl status dsh-autopilot.service
sudo journalctl --unit dsh-autopilot.service --since today
```

The process stays on DSH's supported loopback Web binding. Reach it from an operator workstation with an authenticated,
encrypted SSH tunnel, then open the loopback URL printed by DSH:

```sh
ssh -N -L 127.0.0.1:14500:127.0.0.1:14500 operator@vps.example
```

This is an administrative access path, not a public Web deployment. Do not copy a `0.0.0.0` example: the selected DSH
Web cohort rejects it, and a generic reverse proxy does not make durable Settings safe on a remote hostname. A public
TLS deployment remains unclaimed until the separate paired-access composition passes the plugin access acceptance suite.

Keep provider credentials out of the unit, Settings snapshots, backup command line and shell environment. When live
providers arrive, provision encrypted systemd credentials (or an equivalently private host credential mechanism), expose
only their credential references to the DSH credential/provider configuration, and back up the encrypted source through
the operator's secret-recovery system. Configure model credentials through the selected DSH provider; Autopilot neither
reads nor stores them.

## Shutdown and health

`systemctl stop dsh-autopilot` gives the Host five minutes to fence admission, quiesce managed Agent/process ranges,
flush Sessions, persist pause/recovery facts, close the stores and finally release the runtime-owner fence. systemd's
control-group kill policy is a last resort after that bounded graceful shutdown; a forced kill leaves recovery work for
the next start.

Operational health has independent facts:

- process liveness and whether this Host holds the configured runtime-store fence;
- maintenance-store usability;
- unfinished-run, cleanup-intent and registered publication/delivery recovery;
- current code-host disposition availability;
- admission permitted, intentionally paused, or blocked by recovery.

A running process with recovery or persistence failure is not ready to dispatch. An intentionally disabled/draining
scheduler is paused, not dead. On restart, the owner fence is acquired before run-state recovery. New dispatch remains
blocked while an interrupted run or registered #8 recovery participant reports pending/failed work.

## Consistent backup

Use an offline backup. Stopping the service is the consistency boundary across SQLite, DSH Session files, Git's common
directory and linked worktrees; copying them live at unrelated instants is not a supported backup.

```sh
sudo systemctl stop dsh-autopilot.service
sudo test ! -e /var/lib/dsh-autopilot/runtime/state.sqlite.autopilot-owner
sudo install -d -m 0700 /var/backups/dsh-autopilot
sudo tar -C / -cpf /var/backups/dsh-autopilot/autopilot-YYYYMMDDTHHMMSSZ.tar \
  var/lib/dsh \
  var/lib/dsh-autopilot/runtime \
  var/lib/dsh-autopilot/worktrees \
  var/lib/dsh-autopilot/package \
  srv/autopilot-target
sudo systemctl start dsh-autopilot.service
```

Record the archive checksum, exact DSH version, plugin artifact checksum and effective profile dump beside the archive.
Do not add the released `.autopilot-owner` directory to an archive; its presence means shutdown did not complete and the
backup must not proceed. The target repository is required because retained worktrees point to its common Git directory.

## Restore drill

Test restore on a replacement VPS or an isolated filesystem namespace; never over a running Host. Install the same Node,
pnpm and Git cohort, stop the service, verify the archive checksum, extract all five roots together, restore the dedicated
account ownership/modes, and keep admission disabled for inspection:

```sh
sudo systemctl stop dsh-autopilot.service
sudo tar -C / -xpf /var/backups/dsh-autopilot/autopilot-YYYYMMDDTHHMMSSZ.tar
sudo chown -R dsh-autopilot:dsh-autopilot /var/lib/dsh /var/lib/dsh-autopilot /srv/autopilot-target
sudo -u dsh-autopilot git -C /srv/autopilot-target worktree list --porcelain
sudo systemctl start dsh-autopilot.service
sudo systemctl status dsh-autopilot.service
```

Confirm the runtime owner is held, persistence is ready, every retained path is managed/missing/orphaned as expected,
Sessions resolve, and recovery is complete before enabling admission. Missing paths and orphans require reconciliation;
workspace association alone never authorizes deletion. Restore encrypted provider credentials through the separate
private secret-recovery mechanism, then verify integrations. A pending cleanup intent is reconciled to either “path still
present; preview again” or “path absent; removal completed before acknowledgement”; it is never blindly replayed.

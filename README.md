# X Locations

Brave extension that puts X's **Account based in** country next to usernames. Same value as the About tab on a profile, not the free-text location in the bio.

You have to be logged into X. Lookups stay on `x.com`.

## Install

```bash
./setup
```

That appends this folder to `--load-extension=` in `~/.config/brave-flags.conf` (and Chromium's file if you have one). Fully quit Brave and open it again. An in-app restart keeps the old flags and will not load this. The toolbar button is just a reminder it is installed.

Already on the timeline, replies, and profile header, after the timestamp, or after the @handle when there is no time. Hover the flag for the country name. Regions such as "Europe & Central Asia" get a globe.

## Files

- `page.js` calls X's `AboutAccountQuery` from the page's own session
- `content.js` finds author rows and inserts the flag
- `flags.js` maps country names to emoji

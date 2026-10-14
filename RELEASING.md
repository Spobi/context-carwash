# Releasing

1. `npm test`
2. Add the changes to `CHANGELOG.md`.
3. `npm version patch -m "Release %s"` then `git push --follow-tags`
4. `npm publish`

## Warning people on a broken version

Everyone on the version sees the warning under their meter, and when a session starts, within a day:

```sh
npm deprecate context-carwash@"<=0.1.6" "Briefs can be lost on /clear. Please update."
```

Publish the fix first, so the update command it shows gets the fixed version. Keep the message short: it is cut at 200 characters. To take a warning back:

```sh
npm deprecate context-carwash@"<=0.1.6" ""
```

npm also shows this message to anyone installing that version.

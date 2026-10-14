# Changelog

## 0.1.7

- `carwash doctor` checks that the Node Carwash runs with is still there, and says how to fix it if not. Removing that Node, for example an old version in nvm, stops the meter and `/wash` until install is run again. The installer now says which Node that is.
- Clearer wording on when Carwash goes online, and a reminder to look over `doctor` output before posting it in a public issue.

## 0.1.6

- Update notices: once a day, a new session checks npm in the background. A line under the meter says when a newer version is out, or when the version you have carries a warning. `CARWASH_NO_UPDATE_CHECK=1` turns it off.
- `carwash doctor`: checks the install and prints versions and recent errors, ready to paste into a bug report.
- The status line says when a hook has failed, until `doctor` has shown the error.
- `/wash help` shows the version you have.

## 0.1.5

- `stats --share` sends to the Context Carwash Google Form.

## 0.1.4

- `carwash stats` and `/wash stats`: how much context `/wash` has kept from being sent again, measured from the fresh sessions' transcripts.

## 0.1.3

- An out-of-date installer hands over to the newest release.

## 0.1.2

- The installer says when a newer version is on npm.

## 0.1.1

- Shorter welcome note. Status line hints are sized to the window.

## 0.1.0

- First release on npm: the context meter, the installer and uninstaller, `/wash`, and brief delivery on `/clear`.

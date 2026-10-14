# Changelog

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

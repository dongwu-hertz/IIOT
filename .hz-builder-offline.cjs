'use strict'
const base = require('./scripts/electron-builder.offline.cjs')
module.exports = {
  ...base,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  win: {
    ...base.win,
    signAndEditExecutable: false
  }
}
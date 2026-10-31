// Package api holds the OpenAPI description of Ulka's public API. It is written by hand and kept true by
// internal/app's spec test, which fails when a route or error code and the spec disagree.
package api

import _ "embed"

//go:embed openapi.json
var Spec []byte

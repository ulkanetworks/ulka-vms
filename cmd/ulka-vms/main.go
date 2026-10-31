// Command ulka-vms is the API, the worker and the migrations of ulka-vms, an open-source video platform.
package main

import (
	_ "time/tzdata" // zone names work on a machine without a tz database

	"github.com/ulkanetworks/ulka-vms/app"
)

func main() { app.Main(app.Extension{}) }

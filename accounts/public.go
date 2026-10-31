package accounts

import (
	"context"

	"github.com/ulkanetworks/ulka-vms/core"
)

// What other modules may use from accounts.

// RenameWorkspace renames t's workspace under the same rules as the owner's rename.
func RenameWorkspace(ctx context.Context, t core.TenantTx, name string) error {
	name, err := cleanName(name, true)
	if err != nil {
		return err
	}
	return t.RenameTenant(ctx, name)
}

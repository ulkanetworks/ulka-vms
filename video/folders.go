package video

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

type FolderView struct {
	ID        pgtype.UUID `json:"id"`
	ParentID  pgtype.UUID `json:"parent_id"` // null: directly in Home
	Name      string      `json:"name"`
	Videos    int32       `json:"videos"` // videos directly in it, not in folders below
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}

// listFolders returns every folder of a library, flat; the client builds the tree from parent_id.
func (s *module) listFolders(w http.ResponseWriter, r *http.Request, p core.Principal) {
	out := []FolderView{}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if libs, err := q.ListLibraries(r.Context(), id); err != nil {
			return err
		} else if len(libs) == 0 {
			return errNotFound
		}
		rows, err := q.ListFolders(r.Context(), id)
		for _, f := range rows {
			out = append(out, FolderView{f.ID, f.ParentID, f.Name, f.Videos, f.CreatedAt.Time, f.UpdatedAt.Time})
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{"data": out})
}

// folderError names the constraint a folder write ran into: a taken name, or a parent that isn't in this library.
func folderError(err error) error {
	if pgErr := (*pgconn.PgError)(nil); errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return errFolderNameTaken
		case "23503":
			return errInvalidMove
		}
	}
	return err
}

// parseTarget reads a folder id from a request: "root" or empty is Home (null), else a uuid.
func parseTarget(s string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if s == "" || s == "root" {
		return id, nil
	}
	if id.Scan(s) != nil {
		return id, errInvalidMove
	}
	return id, nil
}

func (s *module) createFolder(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name     string `json:"name"`
		ParentID string `json:"parent_id"`
	}
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	parent, perr := parseTarget(in.ParentID)
	if !validName(in.Name) || perr != nil {
		core.RespondError(w, r, errInvalidFolder)
		return
	}
	var out FolderView
	err := withPathID(s.Deps, r, p, func(q tx, library pgtype.UUID) error {
		if libs, err := q.ListLibraries(r.Context(), library); err != nil {
			return err
		} else if len(libs) == 0 {
			return errNotFound
		}
		id, err := q.CreateFolder(r.Context(), db.CreateFolderParams{LibraryID: library, ParentID: parent, Name: in.Name})
		if err != nil {
			return folderError(err)
		}
		out = FolderView{ID: id, ParentID: parent, Name: in.Name, CreatedAt: time.Now(), UpdatedAt: time.Now()}
		return nil
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, out)
}

// updateFolder renames a folder and/or moves it under another folder of its library (parent_id "root" is Home).
func (s *module) updateFolder(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		in.Name = &trimmed
		if !validName(trimmed) {
			core.RespondError(w, r, errInvalidFolder)
			return
		}
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if _, err := q.GetFolder(r.Context(), id); err != nil {
			return err
		}
		if in.ParentID != nil {
			parent, err := parseTarget(*in.ParentID)
			if err != nil {
				return err
			}
			sub, err := q.FolderSubtree(r.Context(), id)
			if err != nil {
				return err
			}
			if parent.Valid && slices.Contains(sub, parent) { // into itself or one of its own folders
				return errInvalidMove
			}
			if _, err := q.MoveFolder(r.Context(), db.MoveFolderParams{ID: id, ParentID: parent}); err != nil {
				return folderError(err)
			}
		}
		if in.Name != nil {
			if _, err := q.RenameFolder(r.Context(), db.RenameFolderParams{ID: id, Name: *in.Name}); err != nil {
				return folderError(err)
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteFolder removes a folder and the folders below it; the videos inside go to the trash, not away.
func (s *module) deleteFolder(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if _, err := q.GetFolder(r.Context(), id); err != nil {
			return err
		}
		sub, err := q.FolderSubtree(r.Context(), id)
		if err != nil {
			return err
		}
		if _, err := q.TrashAssetsInFolders(r.Context(), sub); err != nil {
			return err
		}
		_, err = q.DeleteFolder(r.Context(), id)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

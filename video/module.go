package video

import (
	"net/http"

	"github.com/ulkanetworks/ulka-vms/core"
)

// Options are what an application built on ulka-vms adds to video; the zero value is ulka-vms on its own.
type Options struct {
	ClickHouseURL string       // where MP4 downloads are counted with delivery
	Managed       ManagedCDN   // a CDN the application runs; nil offers the workspace's own CDN instead
	ConvertImage  ImageConvert // redraws uploaded covers; nil uses ffmpeg
}

type module struct {
	*core.Deps
	managed    ManagedCDN
	convert    ImageConvert
	player     PlayerDocs
	cache      *playbackCache      // ready videos' playback facts (cache.go)
	deliveries *core.ClickHouseLog // MP4 downloads, as lines of the origin's access log (download.go)
}

func Routes(mux *http.ServeMux, d *core.Deps, o Options, player PlayerDocs) error {
	s := &module{Deps: d, managed: o.Managed, convert: o.ConvertImage, player: player, cache: newPlaybackCache(), deliveries: core.NewClickHouseLog(o.ClickHouseURL, "origin_access_logs")}
	if s.convert == nil {
		s.convert = ffmpegConvert
	}
	playerURL = d.PlayerURL
	mux.HandleFunc("POST /v1/uploads", s.Auth("video:write", s.forgetting(s.createUpload)))
	mux.HandleFunc("PUT /v1/uploads/{id}", s.putUpload)
	mux.HandleFunc("GET /v1/uploads/{id}", s.uploadStatus)
	mux.HandleFunc("OPTIONS /v1/uploads/{id}", s.uploadPreflight)
	mux.HandleFunc("POST /v1/assets", s.Auth("video:write", s.forgetting(s.createAsset)))
	mux.HandleFunc("GET /v1/assets", s.Auth("video:read", s.listAssets))
	mux.HandleFunc("GET /v1/assets/{id}", s.Auth("video:read", s.getAsset))
	mux.HandleFunc("PATCH /v1/assets/{id}", s.Auth("video:write", s.forgetting(s.updateAsset)))
	mux.HandleFunc("PUT /v1/assets/{id}/chapters", s.Auth("video:write", s.forgetting(s.putChapters)))
	mux.HandleFunc("POST /v1/assets/trash", s.Auth("video:write", s.forgetting(s.trashAssets)))
	mux.HandleFunc("POST /v1/assets/restore", s.Auth("video:write", s.forgetting(s.restoreAssets)))
	mux.HandleFunc("POST /v1/assets/purge", s.Auth("video:write", s.forgetting(s.purgeAssets)))
	mux.HandleFunc("POST /v1/assets/move", s.Auth("video:write", s.forgetting(s.moveAssetsHandler)))
	mux.HandleFunc("GET /v1/libraries", s.Auth("video:read", s.listLibraries))
	mux.HandleFunc("POST /v1/libraries", s.Auth("video:write", s.forgetting(s.createLibrary)))
	mux.HandleFunc("GET /v1/libraries/{id}", s.Auth("video:read", s.getLibrary))
	mux.HandleFunc("PATCH /v1/libraries/{id}", s.Auth("video:write", s.forgetting(s.updateLibrary)))
	mux.HandleFunc("DELETE /v1/libraries/{id}", s.Auth("video:write", s.forgetting(s.deleteLibrary)))
	mux.HandleFunc("GET /v1/libraries/{id}/transcoding", s.Auth("video:read", s.getTranscoding))
	mux.HandleFunc("PUT /v1/libraries/{id}/transcoding", s.Auth("video:write", s.forgetting(s.putTranscoding)))
	mux.HandleFunc("POST /v1/libraries/{id}/presets", s.Auth("video:write", s.forgetting(s.createPreset)))
	mux.HandleFunc("PATCH /v1/presets/{id}", s.Auth("video:write", s.forgetting(s.updatePreset)))
	mux.HandleFunc("DELETE /v1/presets/{id}", s.Auth("video:write", s.forgetting(s.deletePreset)))
	mux.HandleFunc("GET /v1/libraries/{id}/folders", s.Auth("video:read", s.listFolders))
	mux.HandleFunc("POST /v1/libraries/{id}/folders", s.Auth("video:write", s.forgetting(s.createFolder)))
	mux.HandleFunc("PATCH /v1/folders/{id}", s.Auth("video:write", s.forgetting(s.updateFolder)))
	mux.HandleFunc("DELETE /v1/folders/{id}", s.Auth("video:write", s.forgetting(s.deleteFolder)))
	mux.HandleFunc("DELETE /v1/assets/{id}", s.Auth("video:write", s.forgetting(s.deleteAsset)))
	mux.HandleFunc("POST /v1/assets/{id}/retry", s.Auth("video:write", s.forgetting(s.retryAsset)))
	mux.HandleFunc("GET /v1/assets/{id}/jobs", s.Auth("video:read", s.listAssetJobs))
	mux.HandleFunc("GET /v1/assets/{id}/technical", s.Auth("video:read", s.getTechnical))
	mux.HandleFunc("GET /v1/assets/{id}/playback-check", s.Auth("video:read", s.playbackCheck))
	mux.HandleFunc("GET /v1/assets/{id}/playback-reports", s.Auth("video:read", s.listPlaybackReports))
	mux.HandleFunc("GET /v1/playback-reports/{code}", s.Auth("video:read", s.getPlaybackReport))
	mux.HandleFunc("POST /v1/assets/{id}/link-check", s.Auth("video:read", s.linkCheck))
	mux.HandleFunc("GET /v1/jobs/{id}", s.Auth("video:read", s.getJob))
	mux.HandleFunc("POST /v1/assets/{id}/download", s.Auth("video:write", s.forgetting(s.requestDownload)))
	mux.HandleFunc("PUT /v1/assets/{id}/poster", s.Auth("video:write", s.forgetting(s.setPoster)))
	mux.HandleFunc("PUT /v1/assets/{id}/poster/image", s.Auth("video:write", s.forgetting(s.uploadPoster)))
	mux.HandleFunc("POST /v1/assets/{id}/captions", s.Auth("video:write", s.forgetting(s.addCaptions)))
	mux.HandleFunc("GET /v1/assets/{id}/captions", s.Auth("video:read", s.listCaptions))
	mux.HandleFunc("DELETE /v1/assets/{id}/captions/{captionId}", s.Auth("video:write", s.forgetting(s.deleteCaptions)))
	mux.HandleFunc("DELETE /v1/assets/{id}/download", s.Auth("video:write", s.forgetting(s.removeDownload)))
	mux.HandleFunc("POST /v1/signing-keys", s.Auth("video:write", s.forgetting(s.createSigningKey)))
	mux.HandleFunc("GET /v1/signing-keys", s.Auth("video:read", s.listSigningKeys))
	mux.HandleFunc("DELETE /v1/signing-keys/{id}", s.Auth("video:write", s.forgetting(s.deleteSigningKey)))
	mux.HandleFunc("POST /v1/signed-urls", s.Auth("video:read", s.createSignedURL))
	mux.HandleFunc("GET /v1/video/delivery", s.Auth("video:read", s.getDeliveryHandler))
	mux.HandleFunc("PUT /v1/video/delivery", s.Auth("video:write", s.forgetting(s.putDelivery)))
	mux.HandleFunc("GET /v1/video/defaults", s.Auth("video:read", s.getDefaults))
	mux.HandleFunc("PUT /v1/video/defaults", s.Auth("video:write", s.forgetting(s.putDefaults)))
	mux.HandleFunc("GET /v1/video/stats", s.Auth("video:read", s.videoStats))
	// The player host (PLAYER_URL): pages, playlists, keys, captions and images by library and video.
	mux.HandleFunc("GET /play/{path...}", s.play)
	mux.HandleFunc("POST /play/{path...}", s.playReport)
	return nil
}

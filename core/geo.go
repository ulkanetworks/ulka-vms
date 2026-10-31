package core

import (
	"net/netip"

	"github.com/oschwald/maxminddb-golang/v2"
)

// Geo finds a visitor's country in a self-hosted IP database (GEOIP_DB: DB-IP's free country file, or MaxMind's).
type Geo struct{ db *maxminddb.Reader }

func OpenGeo(path string) (*Geo, error) {
	db, err := maxminddb.Open(path)
	if err != nil {
		return nil, err
	}
	return &Geo{db}, nil
}

// Country is the address's two-letter country code, or "" when it is unknown (a private address, or no database).
func (g *Geo) Country(addr netip.Addr) string {
	if g == nil || !addr.IsValid() {
		return ""
	}
	var rec struct {
		Country struct {
			ISOCode string `maxminddb:"iso_code"`
		} `maxminddb:"country"`
	}
	if err := g.db.Lookup(addr.Unmap()).Decode(&rec); err != nil {
		return ""
	}
	return rec.Country.ISOCode
}

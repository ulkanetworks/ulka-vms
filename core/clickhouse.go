package core

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// ClickHouseQuery runs one query over ClickHouse's HTTP interface and hands each JSONEachRow line to each.
func ClickHouseQuery(ctx context.Context, base, sql string, params map[string]string, each func([]byte) error) error {
	q := url.Values{"output_format_json_quote_64bit_integers": {"0"}}
	for k, v := range params {
		q.Set("param_"+k, v)
	}
	res, err := clickhouseDo(ctx, base, q, strings.NewReader(sql))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		if err := each(sc.Bytes()); err != nil {
			return err
		}
	}
	return sc.Err()
}

// ClickHouseInsert appends JSONEachRow lines to table. Callers send small batches often, so the server gathers
// them into larger parts (async insert), and the call returns once they are written.
func ClickHouseInsert(ctx context.Context, base, table string, rows io.Reader) error {
	res, err := clickhouseDo(ctx, base, url.Values{
		"query":        {"INSERT INTO " + table + " FORMAT JSONEachRow"},
		"async_insert": {"1"}, "wait_for_async_insert": {"1"},
	}, rows)
	if err != nil {
		return err
	}
	return res.Body.Close()
}

// clickhouseDo posts body with the URL's credentials sent as basic auth, never in the query string.
func clickhouseDo(ctx context.Context, base string, q url.Values, body io.Reader) (*http.Response, error) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	for k, v := range u.Query() {
		q[k] = v
	}
	u.RawQuery = q.Encode()
	user := u.User
	u.User = nil
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), body)
	if err != nil {
		return nil, err
	}
	if user != nil {
		pw, _ := user.Password()
		req.SetBasicAuth(user.Username(), pw)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 1000))
		return nil, fmt.Errorf("clickhouse: HTTP %d: %s", res.StatusCode, msg)
	}
	return res, nil
}

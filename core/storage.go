package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

type Storage struct {
	S3     *s3.Client
	Bucket string
}

func (st Storage) PresignGet(ctx context.Context, key string) (string, error) {
	req, err := s3.NewPresignClient(st.S3).PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &st.Bucket, Key: &key}, s3.WithPresignExpires(time.Hour))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

var contentTypes = map[string]string{".m3u8": "application/vnd.apple.mpegurl", ".m4s": "video/iso.segment", ".mp4": "video/mp4"}

func (st Storage) PutFile(ctx context.Context, key, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = st.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: &st.Bucket, Key: &key, Body: f, ContentType: aws.String(contentTypes[filepath.Ext(path)])})
	return err
}

func (st Storage) GetFile(ctx context.Context, key, path string) error {
	obj, err := st.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: &st.Bucket, Key: &key})
	if err != nil {
		return err
	}
	defer obj.Body.Close()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, obj.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// DeletePrefix removes every object under prefix, and aborts unfinished multipart uploads there too.
func (st Storage) DeletePrefix(ctx context.Context, prefix string) error {
	uploads, err := st.S3.ListMultipartUploads(ctx, &s3.ListMultipartUploadsInput{Bucket: &st.Bucket, Prefix: &prefix})
	if err != nil {
		return err
	}
	for _, u := range uploads.Uploads {
		if _, err := st.S3.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &st.Bucket, Key: u.Key, UploadId: u.UploadId}); err != nil {
			return err
		}
	}
	pages := s3.NewListObjectsV2Paginator(st.S3, &s3.ListObjectsV2Input{Bucket: &st.Bucket, Prefix: &prefix})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return err
		}
		if len(page.Contents) == 0 {
			continue
		}
		ids := make([]types.ObjectIdentifier, len(page.Contents))
		for i, o := range page.Contents {
			ids[i] = types.ObjectIdentifier{Key: o.Key}
		}
		if _, err := st.S3.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: &st.Bucket, Delete: &types.Delete{Objects: ids}}); err != nil {
			return err
		}
	}
	return nil
}

func (st Storage) ReadObject(ctx context.Context, key string) ([]byte, error) {
	obj, err := st.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: &st.Bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()
	return io.ReadAll(obj.Body)
}

// Check writes, reads back and deletes a small file, proving the bucket exists and the key may do all three.
func (st Storage) Check(ctx context.Context) error {
	key := "storage-check/" + time.Now().UTC().Format("20060102T150405.000000000")
	want := []byte("ok")
	if _, err := st.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: &st.Bucket, Key: &key, Body: bytes.NewReader(want)}); err != nil {
		return fmt.Errorf("writing a file to bucket %q: %w", st.Bucket, err)
	}
	got, err := st.ReadObject(ctx, key)
	if err != nil {
		return fmt.Errorf("reading a file back from bucket %q: %w", st.Bucket, err)
	}
	if !bytes.Equal(got, want) {
		return fmt.Errorf("bucket %q gave back different contents than were written", st.Bucket)
	}
	if _, err := st.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &st.Bucket, Key: &key}); err != nil {
		return fmt.Errorf("deleting a file from bucket %q: %w", st.Bucket, err)
	}
	return nil
}

// storageProblems are the provider answers a person setting up storage meets, in words that say what to fix.
var storageProblems = map[string]string{
	"SignatureDoesNotMatch":        "the secret access key is wrong for this access key ID",
	"InvalidAccessKeyId":           "the storage doesn't know this access key ID",
	"NoSuchBucket":                 "there's no bucket with this name at this storage address",
	"AccessDenied":                 "this key isn't allowed to write, read and delete in the bucket",
	"AuthorizationHeaderMalformed": "the region is wrong for this storage (R2 takes auto)",
	"PermanentRedirect":            "the bucket is in another region: set that region, or the storage address for it",
	"RequestTimeTooSkewed":         "this server's clock is wrong: turn on time sync (timedatectl set-ntp true)",
}

// StorageProblem says in plain words why Check failed.
func StorageProblem(err error) string {
	var api smithy.APIError
	var nerr net.Error
	switch {
	case errors.As(err, &api) && storageProblems[api.ErrorCode()] != "":
		return storageProblems[api.ErrorCode()]
	case errors.As(err, &api):
		return "the storage refused: " + api.ErrorCode() + ": " + api.ErrorMessage()
	case errors.Is(err, context.DeadlineExceeded) || errors.As(err, &nerr) && nerr.Timeout():
		return "the storage address didn't answer in time"
	case errors.As(err, &nerr):
		return "couldn't reach the storage address from this server: " + err.Error()
	}
	return err.Error()
}

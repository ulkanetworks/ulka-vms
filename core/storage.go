package core

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
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

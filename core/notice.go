package core

import "time"

// Notice is one thing to look at. Kind is a stable code the console words; the API decides the severity.
type Notice struct {
	ID       string         `json:"id"` // stable across requests: kind plus what it's about
	Kind     string         `json:"kind"`
	Severity string         `json:"severity"` // danger, warning or info
	Subject  string         `json:"subject,omitempty"`
	Name     string         `json:"name,omitempty"`
	At       time.Time      `json:"at"` // when it happened, or when it will
	Data     map[string]any `json:"data,omitempty"`
}

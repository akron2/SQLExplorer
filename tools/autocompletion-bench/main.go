package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/bytebase/omni/pg/catalog"
	"github.com/bytebase/omni/pg/completion"
)

type request struct {
	DDL        string   `json:"ddl"`
	SQL        string   `json:"sql"`
	Offset     int      `json:"offset"`
	SearchPath []string `json:"searchPath"`
}

type candidate struct {
	Text string `json:"text"`
	Type int    `json:"type"`
}

type response struct {
	Candidates []candidate `json:"candidates"`
	ElapsedMs  float64     `json:"elapsedMs"`
	Error      string      `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()
	encoder := json.NewEncoder(writer)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		res := response{}
		if err := json.Unmarshal(line, &req); err != nil {
			res.Error = err.Error()
			_ = encoder.Encode(res)
			continue
		}
		var cat *catalog.Catalog
		if req.DDL != "" {
			loaded, err := catalog.LoadSQL(req.DDL)
			if err != nil {
				res.Error = "ddl: " + err.Error()
				_ = encoder.Encode(res)
				continue
			}
			cat = loaded
		}
		if cat != nil && len(req.SearchPath) > 0 {
			cat.SetSearchPath(req.SearchPath)
		}
		started := time.Now()
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					res.Error = fmt.Sprintf("panic: %v", recovered)
				}
			}()
			for _, item := range completion.Complete(req.SQL, req.Offset, cat) {
				res.Candidates = append(res.Candidates, candidate{Text: item.Text, Type: int(item.Type)})
			}
		}()
		res.ElapsedMs = float64(time.Since(started).Microseconds()) / 1000.0
		_ = encoder.Encode(res)
	}
}

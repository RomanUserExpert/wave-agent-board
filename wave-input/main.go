// wave-input writes text into a Wave terminal block's PTY, as if it was typed.
//
//	echo "hello" | wave-input -b <blockid> [-paste] [-enter]
//
// It speaks Wave's RPC protocol directly (newline-delimited JSON over wave.sock),
// authenticating with WAVETERM_JWT, so it has no dependency on the Wave codebase.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"
)

type rpcMessage struct {
	Command string `json:"command,omitempty"`
	ReqId   string `json:"reqid,omitempty"`
	ResId   string `json:"resid,omitempty"`
	Route   string `json:"route,omitempty"`
	Timeout int64  `json:"timeout,omitempty"`
	Error   string `json:"error,omitempty"`
	Data    any    `json:"data,omitempty"`
}

type client struct {
	conn   net.Conn
	reader *bufio.Reader
	nextId int
}

func (c *client) call(command, route string, data any) error {
	c.nextId++
	reqId := fmt.Sprintf("wave-input-%d", c.nextId)
	msg, err := json.Marshal(rpcMessage{Command: command, ReqId: reqId, Route: route, Timeout: 5000, Data: data})
	if err != nil {
		return err
	}
	if _, err := c.conn.Write(append(msg, '\n')); err != nil {
		return err
	}
	c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			return fmt.Errorf("%s: reading response: %w", command, err)
		}
		var resp rpcMessage
		if json.Unmarshal(line, &resp) != nil || resp.ResId != reqId {
			continue // not ours (events etc.)
		}
		if resp.Error != "" {
			return fmt.Errorf("%s: %s", command, resp.Error)
		}
		return nil
	}
}

func socketFromJwt(jwt string) (string, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed WAVETERM_JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("decoding WAVETERM_JWT: %w", err)
	}
	var claims struct {
		Sock string `json:"sock"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Sock == "" {
		return "", errors.New("WAVETERM_JWT has no socket path")
	}
	return claims.Sock, nil
}

func run() error {
	blockId := flag.String("b", "", "target block id")
	enter := flag.Bool("enter", false, "press Enter after the text")
	paste := flag.Bool("paste", false, "always send the text as a bracketed paste (e.g. an image path, so Claude Code attaches it)")
	flag.Parse()
	if *blockId == "" {
		return errors.New("-b <blockid> is required")
	}
	jwt := os.Getenv("WAVETERM_JWT")
	if jwt == "" {
		return errors.New("WAVETERM_JWT not set (run from a Wave terminal)")
	}
	sock, err := socketFromJwt(jwt)
	if err != nil {
		return err
	}
	text, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	text = []byte(strings.TrimRight(string(text), "\r\n"))
	// Multi-line text goes in as a bracketed paste so newlines don't submit early
	if len(text) > 0 && (*paste || strings.Contains(string(text), "\n")) {
		text = append(append([]byte("\x1b[200~"), text...), []byte("\x1b[201~")...)
	}

	conn, err := net.Dial("unix", sock)
	if err != nil {
		return fmt.Errorf("connecting to %s: %w", sock, err)
	}
	defer conn.Close()
	c := &client{conn: conn, reader: bufio.NewReader(conn)}
	if err := c.call("authenticate", "$control", jwt); err != nil {
		return err
	}
	send := func(b []byte) error {
		return c.call("controllerinput", "", map[string]string{
			"blockid":     *blockId,
			"inputdata64": base64.StdEncoding.EncodeToString(b),
		})
	}
	if len(text) > 0 {
		if err := send(text); err != nil {
			return err
		}
	}
	if *enter {
		// a separate, slightly delayed Enter so TUIs don't treat it as part of a paste
		time.Sleep(150 * time.Millisecond)
		if err := send([]byte("\r")); err != nil {
			return err
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "wave-input:", err)
		os.Exit(1)
	}
}

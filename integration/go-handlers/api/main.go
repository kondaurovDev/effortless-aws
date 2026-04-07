package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

// RouteCtx holds parsed request context for a matched route.
type RouteCtx struct {
	Params map[string]string
	Req    events.LambdaFunctionURLRequest
}

type handlerFn func(ctx context.Context, rc RouteCtx) (any, error)

type route struct {
	method  string
	path    string
	handler handlerFn
}

type router struct {
	routes []route
}

func newRouter() *router { return &router{} }

func (r *router) get(path string, h handlerFn)  { r.add("GET", path, h) }
func (r *router) post(path string, h handlerFn) { r.add("POST", path, h) }

func (r *router) add(method, path string, h handlerFn) {
	r.routes = append(r.routes, route{method: method, path: path, handler: h})
}

// matchPath checks if a request path matches a route pattern with {param} placeholders.
func matchPath(pattern, reqPath string) map[string]string {
	patternParts := strings.Split(strings.Trim(pattern, "/"), "/")
	pathParts := strings.Split(strings.Trim(reqPath, "/"), "/")

	if len(patternParts) != len(pathParts) {
		return nil
	}

	params := make(map[string]string)
	for i, pp := range patternParts {
		if strings.HasPrefix(pp, "{") && strings.HasSuffix(pp, "}") {
			params[pp[1:len(pp)-1]] = pathParts[i]
		} else if pp != pathParts[i] {
			return nil
		}
	}
	return params
}

func (r *router) handle(ctx context.Context, req events.LambdaFunctionURLRequest) (events.LambdaFunctionURLResponse, error) {
	method := strings.ToUpper(req.RequestContext.HTTP.Method)
	path := req.RawPath

	for _, rt := range r.routes {
		if rt.method != method {
			continue
		}
		params := matchPath(rt.path, path)
		if params == nil {
			continue
		}

		result, err := rt.handler(ctx, RouteCtx{Params: params, Req: req})
		if err != nil {
			body, _ := json.Marshal(map[string]string{"error": err.Error()})
			return events.LambdaFunctionURLResponse{
				StatusCode: http.StatusInternalServerError,
				Headers:    map[string]string{"content-type": "application/json"},
				Body:       string(body),
			}, nil
		}

		body, _ := json.Marshal(result)
		return events.LambdaFunctionURLResponse{
			StatusCode: http.StatusOK,
			Headers:    map[string]string{"content-type": "application/json"},
			Body:       string(body),
		}, nil
	}

	body, _ := json.Marshal(map[string]string{"error": fmt.Sprintf("not found: %s %s", method, path)})
	return events.LambdaFunctionURLResponse{
		StatusCode: http.StatusNotFound,
		Headers:    map[string]string{"content-type": "application/json"},
		Body:       string(body),
	}, nil
}

func main() {
	r := newRouter()

	r.get("/", func(_ context.Context, _ RouteCtx) (any, error) {
		return map[string]string{"status": "ok", "runtime": "go"}, nil
	})

	r.get("/users/{id}", func(_ context.Context, rc RouteCtx) (any, error) {
		return map[string]string{"id": rc.Params["id"]}, nil
	})

	r.post("/echo", func(_ context.Context, rc RouteCtx) (any, error) {
		var body any

		if err := json.Unmarshal([]byte(rc.Req.Body), &body); err != nil {
			return nil, fmt.Errorf("invalid JSON body: %w", err)
		}
		return body, nil
	})

	lambda.Start(r.handle)
}

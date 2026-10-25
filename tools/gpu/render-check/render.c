/* flagship-test-scene/v1 through EGL (device platform, surfaceless, no display) and OpenGL ES 2:
 * the media.rs reference_scene drawn on the GPU, written as a P6 PPM on stdout. A driver that
 * offers no EGL device fails here: graphics is never inferred from compute. */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <stdio.h>
#include <stdlib.h>

static const char* VS = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
static const char* FS_BG =
    "precision highp float; uniform vec2 size; void main(){ vec2 c = floor(gl_FragCoord.xy);"
    " float y = size.y - 1.0 - c.y; gl_FragColor = vec4(floor(c.x*255.0/(size.x-1.0))/255.0,"
    " floor(y*255.0/(size.y-1.0))/255.0, 64.0/255.0, 1.0); }";
static const char* FS_TRI = "precision highp float; void main(){ gl_FragColor = vec4(1.0); }";

static GLuint prog(const char* fs) {
  GLuint v = glCreateShader(GL_VERTEX_SHADER), f = glCreateShader(GL_FRAGMENT_SHADER), p = glCreateProgram();
  glShaderSource(v, 1, &VS, 0); glCompileShader(v);
  glShaderSource(f, 1, &fs, 0); glCompileShader(f);
  glAttachShader(p, v); glAttachShader(p, f); glBindAttribLocation(p, 0, "p"); glLinkProgram(p);
  return p;
}

int main(int argc, char** argv) {
  int w = argc > 2 ? atoi(argv[1]) : 640, h = argc > 2 ? atoi(argv[2]) : 480;
  PFNEGLQUERYDEVICESEXTPROC qd = (PFNEGLQUERYDEVICESEXTPROC)eglGetProcAddress("eglQueryDevicesEXT");
  PFNEGLGETPLATFORMDISPLAYEXTPROC gpd = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDeviceEXT dev[4]; EGLint n = 0;
  if (!qd || !gpd || !qd(4, dev, &n) || n < 1) { fprintf(stderr, "no EGL device\n"); return 1; }
  EGLDisplay d = gpd(EGL_PLATFORM_DEVICE_EXT, dev[0], 0);
  if (!eglInitialize(d, 0, 0)) { fprintf(stderr, "eglInitialize failed\n"); return 1; }
  EGLint ca[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
  EGLConfig cfg; EGLint nc;
  eglChooseConfig(d, ca, &cfg, 1, &nc);
  EGLint sa[] = {EGL_WIDTH, w, EGL_HEIGHT, h, EGL_NONE};
  EGLSurface s = eglCreatePbufferSurface(d, cfg, sa);
  eglBindAPI(EGL_OPENGL_ES_API);
  EGLint xa[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  EGLContext ctx = eglCreateContext(d, cfg, EGL_NO_CONTEXT, xa);
  if (!eglMakeCurrent(d, s, s, ctx)) { fprintf(stderr, "no context\n"); return 1; }
  glViewport(0, 0, w, h);
  GLuint bg = prog(FS_BG), tri = prog(FS_TRI);
  float quad[] = {-1, -1, 1, -1, -1, 1, 1, 1};
  glEnableVertexAttribArray(0);
  glUseProgram(bg); glUniform2f(glGetUniformLocation(bg, "size"), (float)w, (float)h);
  glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, quad); glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  /* reference_scene's triangle, (w/2, h/8) (w/8, 7h/8) (7w/8, 7h/8) in image space, y down */
  float t[] = {0.0f, 0.75f, -0.75f, -0.75f, 0.75f, -0.75f};
  glUseProgram(tri); glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, t); glDrawArrays(GL_TRIANGLES, 0, 3);
  unsigned char* px = malloc((size_t)w * h * 4);
  glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px);
  printf("P6\n%d %d\n255\n", w, h);
  for (int y = h - 1; y >= 0; y--)
    for (int x = 0; x < w; x++) fwrite(px + ((size_t)y * w + x) * 4, 1, 3, stdout);
  return 0;
}

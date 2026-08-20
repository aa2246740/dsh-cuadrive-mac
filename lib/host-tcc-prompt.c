#include <stdio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>

/* Spawned as a child of the DSH host so TCC dialogs name DSH, not CuaDriver.app. */
int main(void) {
  const void *keys[] = { CFSTR("AXTrustedCheckOptionPrompt") };
  const void *vals[] = { kCFBooleanTrue };
  CFDictionaryRef opts = CFDictionaryCreate(
    kCFAllocatorDefault,
    keys,
    vals,
    1,
    &kCFTypeDictionaryKeyCallBacks,
    &kCFTypeDictionaryValueCallBacks
  );
  Boolean ax = AXIsProcessTrustedWithOptions(opts);
  if (opts) CFRelease(opts);
  Boolean sr = CGRequestScreenCaptureAccess();
  printf(
    "{\"accessibility\":%s,\"screenRecording\":%s}\n",
    ax ? "true" : "false",
    sr ? "true" : "false"
  );
  return 0;
}

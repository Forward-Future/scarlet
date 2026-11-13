// Linked only into a disposable copy of the native Scarlet dev shell by macos.py.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSUInteger benchmarkMouseButtons = 0;
static NSUInteger privatePressedButtons(id ignored, SEL selector) { return benchmarkMouseButtons; }

static void writeJSON(NSString *path, NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    [data writeToFile:path atomically:YES];
}

static NSWindowLevel desktopBackgroundLevel(void) {
    return CGWindowLevelForKey(kCGDesktopWindowLevelKey) - 1;
}

static BOOL isolated(NSWindow *window) {
    return !NSApp.active && !window.isKeyWindow && !window.isMainWindow &&
        (!window.isVisible || (window.ignoresMouseEvents && window.level == desktopBackgroundLevel()));
}

// Directly address this hidden WKWebView. No event is posted to the OS, no cursor is
// moved and no window is ordered, made key or activated. Coordinates are CSS points.
@interface ScarletTimelinePointer : NSObject <WKScriptMessageHandlerWithReply>
@property(nonatomic, weak) WKWebView *view;
@end

@implementation ScarletTimelinePointer
- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))reply {
    WKWebView *view = self.view;
    NSDictionary *b = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
    NSString *kind = b[@"type"];
    NSDictionary *types = @{@"pointerdown":@(NSEventTypeLeftMouseDown), @"pointermove":@(NSEventTypeLeftMouseDragged),
                            @"pointerup":@(NSEventTypeLeftMouseUp)};
    NSNumber *type = types[kind ?: @""];
    if (!type || !message.frameInfo.isMainFrame || ![message.frameInfo.securityOrigin.host isEqual:@"127.0.0.1"] ||
        !isolated(view.window) ||
        ![b[@"x"] isKindOfClass:NSNumber.class] || ![b[@"y"] isKindOfClass:NSNumber.class]) {
        reply(nil, @"Pointer request is outside the isolated timeline"); return;
    }
    double x = [b[@"x"] doubleValue], y = [b[@"y"] doubleValue];
    if (!isfinite(x) || !isfinite(y) || x < 0 || y < 0 || x >= NSWidth(view.bounds) || y >= NSHeight(view.bounds)) {
        reply(nil, @"Point is outside the view"); return;
    }
    [view callAsyncJavaScript:@"return document.elementFromPoint(x, y)?.closest('.timeline-slider') ? innerHeight : 0;"
                  arguments:@{@"x":@(x), @"y":@(y)} inFrame:nil inContentWorld:WKContentWorld.pageWorld
          completionHandler:^(id valid, NSError *err) {
        if (![valid boolValue] || err || !isolated(view.window)) {
            reply(nil, @"Expected a timeline point in a background window"); return;
        }
        // AppKit's direct event path subtracts window chrome from WebKit's CSS
        // coordinates. Use the observed content viewport to include the titlebar.
        double eventY = y + NSHeight(view.window.frame) - [valid doubleValue];
        NSPoint local = NSMakePoint(x, view.isFlipped ? eventY : NSHeight(view.bounds) - eventY);
        NSEvent *event = [NSEvent mouseEventWithType:type.unsignedIntegerValue
                            location:[view convertPoint:local toView:nil] modifierFlags:0
                            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:view.window.windowNumber
                            context:nil eventNumber:0 clickCount:1 pressure:[kind isEqual:@"pointerup"] ? 0 : 1];
        benchmarkMouseButtons = [kind isEqual:@"pointerup"] ? 0 : 1;
        if ([kind isEqual:@"pointerdown"]) [view mouseDown:event];
        else if ([kind isEqual:@"pointermove"]) [view mouseDragged:event];
        else [view mouseUp:event];
        SEL drained = NSSelectorFromString(@"_doAfterProcessingAllPendingMouseEvents:");
        if ([view respondsToSelector:drained]) {
            ((void (*)(id, SEL, void (^)(void)))objc_msgSend)(view, drained, ^{ reply(@YES,nil); });
        } else reply(@YES, nil);
    }];
}
@end

void scarletBenchPrepare(void) {
    // Set this before Tao constructs its event loop or creates any windows.
    [[NSApplication sharedApplication] setActivationPolicy:NSApplicationActivationPolicyProhibited];
}

void scarletBenchAttach(void *ptr) {
    WKWebView *view = (__bridge WKWebView *)ptr;
    NSString *dir = NSProcessInfo.processInfo.environment[@"SCARLET_BENCH_CONTROL"];
    NSFileManager *files = NSFileManager.defaultManager;
    NSString *requestPath = [dir stringByAppendingPathComponent:@"request.json"];
    NSString *resultPath = [dir stringByAppendingPathComponent:@"result.json"];
    NSString *readyPath = [dir stringByAppendingPathComponent:@"ready.json"];
    NSString *faultPath = [dir stringByAppendingPathComponent:@"fault.json"];
    NSString *scriptPath = [dir stringByAppendingPathComponent:@"measure.js"];
    __block BOOL ready = NO, busy = NO, querying = NO, ordered = NO;
    void (^fault)(NSString *) = ^(NSString *reason) {
        writeJSON(faultPath, @{@"error":reason});
        [NSApp terminate:nil];
    };
    if (!dir || !isolated(view.window) || view.window.isVisible) {
        fault(@"Expected an inactive hidden window at launch");
        return;
    }
    ScarletTimelinePointer *pointer = [ScarletTimelinePointer new];
    // WebKit reads this *process-local* AppKit class method, even for an event
    // delivered directly to a view. Physical buttons from an unrelated app
    // must not affect these programmatically addressed trusted pointer drags.
    Method buttonMask = class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons));
    method_setImplementation(buttonMask, (IMP)privatePressedButtons);
    pointer.view = view;
    [view.configuration.userContentController addScriptMessageHandlerWithReply:pointer
        contentWorld:WKContentWorld.pageWorld name:@"scarletBenchPointer"];
    for (NSNotificationName name in @[NSApplicationDidBecomeActiveNotification, NSWindowDidBecomeKeyNotification]) {
        [[NSNotificationCenter defaultCenter] addObserverForName:name
             object:[name isEqual:NSApplicationDidBecomeActiveNotification] ? NSApp : view.window
              queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { fault(note.name); }];
    }
    // WebKit's page-wide OS mute is additional to the pre-document media-element mute.
    SEL mute = NSSelectorFromString(@"_setPageMuted:");
    BOOL pageMute = [view respondsToSelector:mute];
    if (pageMute) ((void (*)(id, SEL, NSUInteger))objc_msgSend)(view, mute, 1);
    BOOL background = [NSProcessInfo.processInfo.environment[@"SCARLET_BENCH_DRAWABLE"] isEqual:@"1"];
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
        if (!isolated(view.window)) {
            [timer invalidate]; fault(@"Preview escaped its noninteractive background surface"); return;
        }
        if (background && !ordered) {
            NSWindow *window = view.window;
            if (!window) return;
            // Order strictly BELOW the system wallpaper. A drawable is needed for
            // WebKit's normal display link. Never order front or activate the app.
            window.ignoresMouseEvents = YES;
            window.hasShadow = NO;
            window.excludedFromWindowsMenu = YES;
            window.collectionBehavior = NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
            window.level = desktopBackgroundLevel();
            SEL detection = NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
            if ([view respondsToSelector:detection]) ((void (*)(id, SEL, BOOL))objc_msgSend)(view, detection, NO);
            [window orderBack:nil];
            ordered = YES;
            if (!isolated(window) || !window.isVisible) { fault(@"Background drawable was unavailable"); return; }
        }
        if (!ready && !querying) {
            querying = YES;
            NSString *probe = @"(() => ({ loaded:!!document.querySelector('.timeline-slider'), muted:!!window.__scarletBenchMuted && [...document.querySelectorAll('audio,video')].every(v=>v.muted && v.volume===0), vis:document.visibilityState, path:location.pathname, apiOrigin:performance.getEntriesByType('resource').map(r=>new URL(r.name)).find(u=>u.hostname==='127.0.0.1' && u.pathname.startsWith('/api/'))?.origin || '' }))()";
            [view evaluateJavaScript:probe completionHandler:^(NSDictionary *status, NSError *error) {
                querying = NO;
                if (error || ![status isKindOfClass:NSDictionary.class] || ![status[@"loaded"] boolValue]) return;
                if (![status[@"muted"] boolValue]) { fault(@"Media mute could not be verified"); return; }
                ready = YES;
                NSMutableDictionary *proof = [status mutableCopy];
                proof[@"nativeHidden"] = @(!view.window.isVisible);
                proof[@"underDesktop"] = @(view.window.isVisible && view.window.level == desktopBackgroundLevel() && view.window.ignoresMouseEvents);
                proof[@"windowLevel"] = @(view.window.level);
                proof[@"nativeKey"] = @(view.window.isKeyWindow);
                proof[@"nativeMain"] = @(view.window.isMainWindow);
                proof[@"activationPolicy"] = @(NSApp.activationPolicy);
                proof[@"nativePageMuteSupported"] = @(pageMute);
                proof[@"nativePid"] = @(NSProcessInfo.processInfo.processIdentifier);
                writeJSON(readyPath, proof);
            }];
        }
        if (!ready || busy) return;
        NSData *raw = [files contentsAtPath:requestPath];
        if (!raw) return;
        busy = YES;
        [files removeItemAtPath:requestPath error:nil];
        NSDictionary *job = [NSJSONSerialization JSONObjectWithData:raw options:0 error:nil];
        NSString *script = [NSString stringWithContentsOfFile:scriptPath encoding:NSUTF8StringEncoding error:nil];
        if (!script || ![job[@"config"] isKindOfClass:NSDictionary.class] || ![job[@"id"] isKindOfClass:NSString.class]) {
            fault(@"Invalid measurement request"); return;
        }
        [view evaluateJavaScript:[script stringByAppendingString:@"\n;void 0;"] completionHandler:^(id unused, NSError *loadError) {
            if (loadError) { writeJSON(resultPath,@{@"id":job[@"id"],@"error":loadError.localizedDescription}); busy=NO; return; }
            NSString *body = @"if (!window.__scarletBenchMuted || ![...document.querySelectorAll('video,audio')].every(v=>v.muted && v.volume===0)) throw Error('Mute lost'); return JSON.stringify(await window.scarletPlaybackBench.run(config));";
            [view callAsyncJavaScript:body arguments:@{@"config":job[@"config"]} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *err) {
                NSString *reason = err.userInfo[@"WKJavaScriptExceptionMessage"] ?: err.localizedDescription;
                if (!reason) {
                    writeJSON(resultPath, @{@"id":job[@"id"],@"error":@"",@"json":value ?: @""});
                    busy = NO;
                } else {
                    [view evaluateJavaScript:@"JSON.stringify(window.scarletPlaybackBench?.partial ?? null)"
                          completionHandler:^(id partial, NSError *unused) {
                        writeJSON(resultPath,@{@"id":job[@"id"],@"error":reason,@"json":partial ?: @"null"});
                        busy = NO;
                    }];
                }
            }];
        }];
    }];
}

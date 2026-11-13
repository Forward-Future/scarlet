// Sample only the private benchmark window. Store a small color grid, never desktop screenshots.
// Build: xcrun clang -fobjc-arc -framework ScreenCaptureKit -framework CoreMedia -framework
// CoreVideo -framework CoreGraphics -framework AppKit -framework Foundation macos-pixels.m -o macos-pixels
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <libproc.h>
#import <mach/mach_time.h>
#import <signal.h>

@interface PixelObserver : NSObject <SCStreamOutput,SCStreamDelegate>
@property(nonatomic) FILE *log;
@end
@implementation PixelObserver
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    fprintf(stderr,"Private capture stopped (%ld).\n",(long)error.code);
    CFRunLoopStop(CFRunLoopGetMain());
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSDictionary *details = attachments.firstObject;
    NSInteger status = [details[SCStreamFrameInfoStatus] integerValue];
    if (!details || (status != SCFrameStatusComplete && status != SCFrameStatusStarted)) return;
    CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample);
    if (!pixel || CVPixelBufferGetPixelFormatType(pixel) != kCVPixelFormatType_32BGRA) return;
    if (CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return;
    const unsigned char *base = CVPixelBufferGetBaseAddress(pixel);
    size_t w = CVPixelBufferGetWidth(pixel), h = CVPixelBufferGetHeight(pixel), stride=CVPixelBufferGetBytesPerRow(pixel);
    unsigned char rgb[20*12*3], *out=rgb;
    // Fixed interior of the editor monitor on the 1280x800 Scarlet benchmark surface.
    // Coordinates are recorded in the header and mapped to the fitted image after the run.
    for(int y=0; y<12; ++y) for(int x=0; x<20; ++x) {
        int cx=(int)floor((0.55+0.36*(x+0.5)/20)*w), cy=(int)floor((0.25+0.28*(y+0.5)/12)*h);
        const unsigned char *p=base+cy*stride+cx*4;
        *out++=p[2]; *out++=p[1]; *out++=p[0];
    }
    CVPixelBufferUnlockBaseAddress(pixel,kCVPixelBufferLock_ReadOnly);
    double wallMs = NSDate.date.timeIntervalSince1970 * 1000;
    uint64_t timestamp=[details[SCStreamFrameInfoDisplayTime] unsignedLongLongValue];
    mach_timebase_info_data_t scale; mach_timebase_info(&scale);
    uint64_t current=mach_absolute_time();
    double displayMs = timestamp && timestamp<=current ? wallMs-(current-timestamp)*(double)scale.numer/scale.denom/1e6 : wallMs;
    fprintf(self.log,"%.3f %.3f ", displayMs,wallMs);
    static const char digits[]="0123456789abcdef";
    char line[2*sizeof(rgb)+1];
    for(size_t i=0;i<sizeof(rgb);i++) {
        line[2*i]=digits[rgb[i]>>4];
        line[2*i+1]=digits[rgb[i]&15];
    }
    line[sizeof(line)-1]='\n';
    fwrite(line,1,sizeof(line),self.log);
}
@end

int main(int argc,const char **argv) {
    @autoreleasepool {
        if(argc!=3){fprintf(stderr,"usage: macos-pixels private-ready.json private-grid.txt\n");return 2;}
        [[NSApplication sharedApplication] setActivationPolicy:NSApplicationActivationPolicyProhibited];
        if(!CGPreflightScreenCaptureAccess()){fprintf(stderr,"Capture access unavailable; skipped without prompting.\n");return 3;}
        NSString *path=@(argv[1]); NSDictionary *ready=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:0 error:NULL];
        int pid=[ready[@"nativePid"] intValue];
        char exe[PROC_PIDPATHINFO_MAXSIZE]={0};
        if(![ready[@"underDesktop"] boolValue] || ![ready[@"muted"] boolValue] || [ready[@"activationPolicy"] intValue]!=2 ||
           pid<=0 || proc_pidpath(pid,exe,sizeof(exe))<=0 ||
           ![[@(exe) stringByResolvingSymlinksInPath] isEqual:[[path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"target/debug/scarlet-desktop"] stringByResolvingSymlinksInPath]]) {
            fprintf(stderr,"Expected the isolated below-desktop Scarlet benchmark process.\n");return 2;
        }
        FILE *output=fopen(argv[2],"wx");
        if(!output){perror("private output");return 2;}
        fchmod(fileno(output),0600);
        setvbuf(output,NULL,_IOLBF,0);
        PixelObserver *observer=[PixelObserver new]; observer.log=output;
        dispatch_queue_t sampleQueue=dispatch_queue_create("scarlet.private.pixels",DISPATCH_QUEUE_SERIAL);
        __block SCStream *stream=nil;
        __block int result=1;
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
            SCWindow *target=nil;
            for(SCWindow *w in content.windows) if(w.owningApplication.processID==pid && w.windowLayer==CGWindowLevelForKey(kCGDesktopWindowLevelKey)-1) { target=w;break; }
            if(!target||error){fprintf(stderr,"Private surface unavailable.\n");CFRunLoopStop(CFRunLoopGetMain());return;}
            SCContentFilter *filter=[[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
            SCStreamConfiguration *c=[SCStreamConfiguration new]; c.ignoreShadowsSingleWindow=YES; c.showsCursor=NO;
            c.capturesAudio=NO; c.width=320;c.height=(size_t)llround(c.width*target.frame.size.height/target.frame.size.width);
            c.minimumFrameInterval=CMTimeMake(1,30); c.queueDepth=3;c.pixelFormat=kCVPixelFormatType_32BGRA;
            c.colorSpaceName=kCGColorSpaceSRGB;c.streamName=@"Scarlet private playback telemetry";
            stream=[[SCStream alloc] initWithFilter:filter configuration:c delegate:observer];
            NSError *setup=nil;
            if(![stream addStreamOutput:observer type:SCStreamOutputTypeScreen sampleHandlerQueue:sampleQueue error:&setup]){
                fprintf(stderr,"Private sampling output unavailable.\n");CFRunLoopStop(CFRunLoopGetMain());return;
            }
            fprintf(output,"# window %.3f %.3f grid %zu %zu samples 20 12\n",target.frame.size.width,target.frame.size.height,c.width,c.height);
            [stream startCaptureWithCompletionHandler:^(NSError *err){
                if(err){fprintf(stderr,"Private stream unavailable (%ld).\n",(long)err.code);CFRunLoopStop(CFRunLoopGetMain());return;}
                result=0;fprintf(stderr,"Sampling only private window %u.\n",target.windowID);
            }];
        }];
        signal(SIGINT,SIG_IGN);signal(SIGTERM,SIG_IGN);
        dispatch_source_t a=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGTERM,0,dispatch_get_main_queue());
        dispatch_source_t b=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,SIGINT,0,dispatch_get_main_queue());
        dispatch_block_t stop=^{ if(stream) [stream stopCaptureWithCompletionHandler:^(NSError *unused){CFRunLoopStop(CFRunLoopGetMain());}]; else CFRunLoopStop(CFRunLoopGetMain()); };
        dispatch_source_set_event_handler(a,stop);dispatch_source_set_event_handler(b,stop);dispatch_resume(a);dispatch_resume(b);
        CFRunLoopRun();dispatch_sync(sampleQueue,^{});fclose(output);return result;
    }
}

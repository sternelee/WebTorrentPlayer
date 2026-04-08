#include "bindings/bindings.h"
#import <AVFoundation/AVFoundation.h>

static void configureAudioSession() {
	AVAudioSession *audioSession = [AVAudioSession sharedInstance];
	NSError *categoryError = nil;
	[audioSession setCategory:AVAudioSessionCategoryPlayback
					 mode:AVAudioSessionModeMoviePlayback
				  options:AVAudioSessionCategoryOptionAllowAirPlay | AVAudioSessionCategoryOptionAllowBluetoothA2DP
					error:&categoryError];

	if (categoryError != nil) {
		NSLog(@"Failed to configure AVAudioSession category: %@", categoryError);
		return;
	}

	NSError *activeError = nil;
	[audioSession setActive:YES error:&activeError];
	if (activeError != nil) {
		NSLog(@"Failed to activate AVAudioSession: %@", activeError);
	}
}

int main(int argc, char * argv[]) {
	@autoreleasepool {
		configureAudioSession();
		ffi::start_app();
	}
	return 0;
}

// The small Objective-C part of the Autark runner (Punkt 17, RUNNER-DESIGN.md 2.2 and 2.6): Objective-C exceptions from XCTest
// caught (Swift cannot), and the pointer path of the XCTest runtime – the undocumented event classes found at run time with
// NSClassFromString, every method checked before it is sent, nothing linked against private symbols. Without them the runner
// swipes in a straight line. Lock signals: the public Darwin notify API, and an XCUIDevice getter only when it is found by name
// with the right signature. Declarations are our own; nothing here comes from another project.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ATKRunnerBridge : NSObject

/// Runs `block`; returns "name: reason" of an Objective-C exception it raised, else nil.
+ (nullable NSString *)catching:(NS_NOESCAPE void (^)(void))block NS_SWIFT_NAME(catching(_:));

/// True when XCPointerEventPath and XCSynthesizedEventRecord exist and answer every method the swipe needs.
+ (BOOL)pathAvailable NS_SWIFT_NAME(pathAvailable());

/// The instance methods of a class by name, sorted and space-separated ("" when the class is missing) – for the CI log only.
+ (NSString *)methodsOf:(NSString *)className NS_SWIFT_NAME(methods(of:));

/// One finger: down at the first point, to each next point at its offset (seconds from touch-down), up at the last.
/// nil = carried out; else a short reason (no screen content).
+ (nullable NSString *)swipeXs:(NSArray<NSNumber *> *)xs
                             ys:(NSArray<NSNumber *> *)ys
                        offsets:(NSArray<NSNumber *> *)offsets
                    orientation:(NSInteger)orientation NS_SWIFT_NAME(swipe(xs:ys:offsets:orientation:));

/// State of a Darwin notification (public notify API, notify.h), e.g. com.apple.springboard.lockstate; -1 when it cannot be
/// read here. The registration is kept for the life of the runner.
+ (long long)notifyState:(NSString *)name NS_SWIFT_NAME(notifyState(_:));

/// The first of `names` that `object` answers as a method without arguments returning BOOL, else nil (looked up, never guessed).
+ (nullable NSString *)boolGetterOf:(id)object among:(NSArray<NSString *> *)names NS_SWIFT_NAME(boolGetter(of:among:));

/// Sends that getter: 1 / 0, or -1 when it raised.
+ (NSInteger)callBool:(id)object getter:(NSString *)name NS_SWIFT_NAME(callBool(_:getter:));

/// For the CI log only: "Class -selector" of every XC* class method whose name holds one of `words` (case-insensitive).
+ (NSString *)selectorsOfXCClassesMatching:(NSArray<NSString *> *)words NS_SWIFT_NAME(selectorsOfXCClasses(matching:));

@end

NS_ASSUME_NONNULL_END

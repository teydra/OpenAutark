#import "RunnerPrivate.h"
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <notify.h>
#import <limits.h>

// The selectors of the XCTest runtime's event classes, declared so ARC knows their memory rules (init returns a retained object).
// They are only sent after instancesRespondToSelector: said yes.
@interface NSObject (ATKRunnerEventPath)
- (instancetype)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
- (instancetype)initWithName:(NSString *)name interfaceOrientation:(NSInteger)orientation;
- (void)addPointerEventPath:(id)path;
- (BOOL)synthesizeWithError:(NSError **)error;
@end

static NSString *const ATKPathClass = @"XCPointerEventPath";
static NSString *const ATKRecordClass = @"XCSynthesizedEventRecord";

@implementation ATKRunnerBridge

+ (NSString *)catching:(NS_NOESCAPE void (^)(void))block {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason ?: @""];
    }
}

+ (BOOL)pathAvailable {
    Class path = NSClassFromString(ATKPathClass);
    Class record = NSClassFromString(ATKRecordClass);
    if (path == nil || record == nil) return NO;
    for (NSString *name in @[@"initForTouchAtPoint:offset:", @"moveToPoint:atOffset:", @"liftUpAtOffset:"]) {
        if (![path instancesRespondToSelector:NSSelectorFromString(name)]) return NO;
    }
    for (NSString *name in @[@"initWithName:interfaceOrientation:", @"addPointerEventPath:", @"synthesizeWithError:"]) {
        if (![record instancesRespondToSelector:NSSelectorFromString(name)]) return NO;
    }
    return YES;
}

+ (NSString *)methodsOf:(NSString *)className {
    Class cls = NSClassFromString(className);
    if (cls == nil) return @"";
    unsigned int count = 0;
    Method *list = class_copyMethodList(cls, &count);
    NSMutableArray<NSString *> *names = [NSMutableArray arrayWithCapacity:count];
    for (unsigned int i = 0; i < count; i++) [names addObject:NSStringFromSelector(method_getName(list[i]))];
    free(list);
    [names sortUsingSelector:@selector(compare:)];
    return [names componentsJoinedByString:@" "];
}

+ (NSString *)swipeXs:(NSArray<NSNumber *> *)xs ys:(NSArray<NSNumber *> *)ys offsets:(NSArray<NSNumber *> *)offsets orientation:(NSInteger)orientation {
    if (![self pathAvailable]) return @"no pointer path in this XCTest runtime";
    NSUInteger count = xs.count;
    if (count < 2 || ys.count != count || offsets.count != count) return @"bad points";
    __block NSString *why = nil;
    NSString *raised = [self catching:^{
        Class pathClass = NSClassFromString(ATKPathClass);
        Class recordClass = NSClassFromString(ATKRecordClass);
        id path = [[pathClass alloc] initForTouchAtPoint:CGPointMake(xs[0].doubleValue, ys[0].doubleValue) offset:0];
        for (NSUInteger i = 1; i < count; i++) {
            [path moveToPoint:CGPointMake(xs[i].doubleValue, ys[i].doubleValue) atOffset:offsets[i].doubleValue];
        }
        [path liftUpAtOffset:offsets[count - 1].doubleValue];
        id record = [[recordClass alloc] initWithName:@"Autark swipe" interfaceOrientation:orientation];
        [record addPointerEventPath:path];
        NSError *error = nil;
        if (![record synthesizeWithError:&error]) why = error != nil ? [NSString stringWithFormat:@"synthesize failed (%@ %ld)", error.domain, (long)error.code] : @"synthesize failed";
    }];
    return raised ?: why;
}

// MARK: lock signals (RunnerLock in AutarkCore decides)

+ (long long)notifyState:(NSString *)name {
    static NSMutableDictionary<NSString *, NSNumber *> *tokens;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ tokens = [NSMutableDictionary dictionary]; });
    @synchronized (tokens) {
        NSNumber *known = tokens[name];
        int token = 0;
        if (known == nil) {
            if (notify_register_check(name.UTF8String, &token) != NOTIFY_STATUS_OK) return -1;
            tokens[name] = @(token);
        } else {
            token = known.intValue;
        }
        uint64_t state = 0;
        if (notify_get_state(token, &state) != NOTIFY_STATUS_OK) return -1;
        return state > (uint64_t)LLONG_MAX ? LLONG_MAX : (long long)state;
    }
}

+ (NSString *)boolGetterOf:(id)object among:(NSArray<NSString *> *)names {
    for (NSString *name in names) {
        SEL selector = NSSelectorFromString(name);
        Method method = class_getInstanceMethod(object_getClass(object), selector);
        if (method == NULL || method_getNumberOfArguments(method) != 2) continue;
        char type[8] = {0};
        method_getReturnType(method, type, sizeof(type));
        if (strcmp(type, "B") == 0 || strcmp(type, "c") == 0) return name;
    }
    return nil;
}

+ (NSInteger)callBool:(id)object getter:(NSString *)name {
    __block NSInteger result = -1;
    NSString *raised = [self catching:^{
        BOOL (*send)(id, SEL) = (BOOL (*)(id, SEL))objc_msgSend;
        result = send(object, NSSelectorFromString(name)) ? 1 : 0;
    }];
    return raised != nil ? -1 : result;
}

+ (NSString *)selectorsOfXCClassesMatching:(NSArray<NSString *> *)words {
    NSMutableArray<NSString *> *hits = [NSMutableArray array];
    unsigned int classCount = 0;
    Class *classes = objc_copyClassList(&classCount);
    for (unsigned int c = 0; c < classCount; c++) {
        const char *raw = class_getName(classes[c]);
        if (raw == NULL || strncmp(raw, "XC", 2) != 0) continue;
        NSString *className = @(raw);
        for (int meta = 0; meta < 2; meta++) {
            Class cls = meta ? object_getClass((id)classes[c]) : classes[c];
            unsigned int count = 0;
            Method *list = class_copyMethodList(cls, &count);
            for (unsigned int i = 0; i < count; i++) {
                NSString *selector = NSStringFromSelector(method_getName(list[i]));
                for (NSString *word in words) {
                    if ([selector rangeOfString:word options:NSCaseInsensitiveSearch].location != NSNotFound) {
                        [hits addObject:[NSString stringWithFormat:@"%@ %@%@", className, meta ? @"+" : @"-", selector]];
                        break;
                    }
                }
            }
            free(list);
        }
    }
    free(classes);
    [hits sortUsingSelector:@selector(compare:)];
    return [hits componentsJoinedByString:@" | "];
}

@end

/**
 * Expo config plugin for One Signal (iOS)
 * @see https://documentation.onesignal.com/docs/react-native-sdk-setup#step-4-install-for-ios-using-cocoapods-for-ios-apps
 */

import {
  ConfigPlugin,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} from "@expo/config-plugins";
import { OneSignalPluginProps } from "./withOneSignal";
import * as fs from 'fs';
import xcode from 'xcode';
import {
  DEFAULT_BUNDLE_SHORT_VERSION,
  DEFAULT_BUNDLE_VERSION,
  IPHONEOS_DEPLOYMENT_TARGET,
  TARGETED_DEVICE_FAMILY
} from "../support/iosConstants";
import { updatePodfile } from "../support/updatePodfile";
import NseUpdaterManager from "../support/NseUpdaterManager";

/* I N T E R F A C E S */
interface PluginOptions {
  iosPath:                  string,
  devTeam?:                 string,
  bundleVersion?:           string,
  bundleShortVersion?:      string,
  bundleIdentifier?:        string,
  iPhoneDeploymentTarget?:  string
}

/**
 * Add 'app-environment' record with current environment to '<project-name>.entitlements' file
 * @see https://documentation.onesignal.com/docs/react-native-sdk-setup#step-4-install-for-ios-using-cocoapods-for-ios-apps
 */
const withAppEnvironment: ConfigPlugin<OneSignalPluginProps> = (
  config,
  onesignalProps
) => {
  return withEntitlementsPlist(config, (newConfig) => {
    if (onesignalProps?.mode == null) {
      throw new Error(`
        Missing required "mode" key in your app.json or app.config.js file for "onesignal-expo-plugin".
        "mode" can be either "development" or "production".
        Please see onesignal-expo-plugin's README.md for more details.`
      )
    }
    newConfig.modResults["aps-environment"] = onesignalProps.mode;
    return newConfig;
  });
};

/**
 * Add "Background Modes -> Remote notifications" and "App Group" permissions
 * @see https://documentation.onesignal.com/docs/react-native-sdk-setup#step-4-install-for-ios-using-cocoapods-for-ios-apps
 */
const withRemoteNotificationsPermissions: ConfigPlugin<OneSignalPluginProps> = (
  config
) => {
  const BACKGROUND_MODE_KEYS = ["remote-notification"];
  return withInfoPlist(config, (newConfig) => {
    if (!Array.isArray(newConfig.modResults.UIBackgroundModes)) {
      newConfig.modResults.UIBackgroundModes = [];
    }
    for (const key of BACKGROUND_MODE_KEYS) {
      if (!newConfig.modResults.UIBackgroundModes.includes(key)) {
        newConfig.modResults.UIBackgroundModes.push(key);
      }
    }

    return newConfig;
  });
};

/**
 * Add "App Group" permission
 * @see https://documentation.onesignal.com/docs/react-native-sdk-setup#step-4-install-for-ios-using-cocoapods-for-ios-apps (step 4.4)
 */
const withAppGroupPermissions: ConfigPlugin<OneSignalPluginProps> = (
  config
) => {
  const APP_GROUP_KEY = "com.apple.security.application-groups";
  return withEntitlementsPlist(config, newConfig => {
    if (!Array.isArray(newConfig.modResults[APP_GROUP_KEY])) {
      newConfig.modResults[APP_GROUP_KEY] = [];
    }
    let modResultsArray = (newConfig.modResults[APP_GROUP_KEY] as Array<any>);
    let entitlement = `group.${newConfig?.ios?.bundleIdentifier || ""}.onesignal`;
    if (modResultsArray.indexOf(entitlement) !== -1) {
      return newConfig;
    }
    modResultsArray.push(entitlement);

    return newConfig;
  });
};

const withOneSignalNSE: ConfigPlugin<OneSignalPluginProps> = (config, onesignalProps) => {
  return withXcodeProject(config, async props => {
    const options: PluginOptions = {
      iosPath: props.modRequest.platformProjectRoot,
      bundleIdentifier: props.ios?.bundleIdentifier,
      devTeam: onesignalProps?.devTeam,
      bundleVersion: props.ios?.buildNumber,
      bundleShortVersion: props?.version,
      iPhoneDeploymentTarget: onesignalProps?.iPhoneDeploymentTarget
    };

    xcodeProjectAddNse(
      props.modRequest.projectName || "",
      options,
      "node_modules/onesignal-expo-plugin/build/support/serviceExtensionFiles/"
    );

    return props;
  });
}

export const withOneSignalIos: ConfigPlugin<OneSignalPluginProps> = (
  config,
  props
) => {
  withAppEnvironment(config, props);
  withRemoteNotificationsPermissions(config, props);
  withAppGroupPermissions(config, props);
  withOneSignalNSE(config, props);
  return config;
};


export function xcodeProjectAddNse(
  appName: string,
  options: PluginOptions,
  sourceDir: string
): void {
  const { iosPath, devTeam, bundleIdentifier, bundleVersion, bundleShortVersion, iPhoneDeploymentTarget } = options;

  updatePodfile(iosPath);
  NseUpdaterManager.updateNSEEntitlements(`group.${bundleIdentifier}.onesignal`)
  NseUpdaterManager.updateNSEBundleVersion(bundleVersion ?? DEFAULT_BUNDLE_VERSION);
  NseUpdaterManager.updateNSEBundleShortVersion(bundleShortVersion ?? DEFAULT_BUNDLE_SHORT_VERSION);

  const projPath = `${iosPath}/${appName}.xcodeproj/project.pbxproj`;
  const targetName = "OneSignalNotificationServiceExtension";

  const extFiles = [
    "NotificationService.h",
    "NotificationService.m",
    `${targetName}.entitlements`,
    `${targetName}-Info.plist`
  ];

  const xcodeProject = xcode.project(projPath);

  xcodeProject.parse(function(err: Error) {
    if (err) {
      console.log(`Error parsing iOS project: ${JSON.stringify(err)}`);
      return;
    }

    // Copy in the extension files
    fs.mkdirSync(`${iosPath}/${targetName}`, { recursive: true });
    extFiles.forEach(function (extFile) {
      let targetFile = `${iosPath}/${targetName}/${extFile}`;

      try {
        fs.createReadStream(`${sourceDir}${extFile}`).pipe(
          fs.createWriteStream(targetFile)
        );
      } catch (err) {
        console.log(err);
      }
    });

    const projObjects = xcodeProject.hash.project.objects;

    // Create new PBXGroup for the extension
    let extGroup = xcodeProject.addPbxGroup(extFiles, targetName, targetName);

    // Add the new PBXGroup to the top level group. This makes the
    // files / folder appear in the file explorer in Xcode.
    let groups = xcodeProject.hash.project.objects["PBXGroup"];
    Object.keys(groups).forEach(function (key) {
      if (groups[key].name === undefined) {
        xcodeProject.addToPbxGroup(extGroup.uuid, key);
      }
    });

    // WORK AROUND for codeProject.addTarget BUG
    // Xcode projects don't contain these if there is only one target
    // An upstream fix should be made to the code referenced in this link:
    //   - https://github.com/apache/cordova-node-xcode/blob/8b98cabc5978359db88dc9ff2d4c015cba40f150/lib/pbxProject.js#L860
    projObjects['PBXTargetDependency'] = projObjects['PBXTargetDependency'] || {};
    projObjects['PBXContainerItemProxy'] = projObjects['PBXTargetDependency'] || {};

    if (!!xcodeProject.pbxTargetByName(targetName)) {
      console.log(targetName, "already exists in project. Skipping...");
      return;
    }

    // Add the NSE target
    // This adds PBXTargetDependency and PBXContainerItemProxy for you
    const nseTarget = xcodeProject.addTarget(targetName, "app_extension", targetName, `${bundleIdentifier}.${targetName}`);

    // Add build phases to the new target
    xcodeProject.addBuildPhase(
      ["NotificationService.m"],
      "PBXSourcesBuildPhase",
      "Sources",
      nseTarget.uuid
    );
    xcodeProject.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", nseTarget.uuid);

    xcodeProject.addBuildPhase(
      [],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      nseTarget.uuid
    );

    // Edit the Deployment info of the new Target, only IphoneOS and Targeted Device Family
    // However, can be more
    let configurations = xcodeProject.pbxXCBuildConfigurationSection();
    for (let key in configurations) {
      if (
        typeof configurations[key].buildSettings !== "undefined" &&
        configurations[key].buildSettings.PRODUCT_NAME == `"${targetName}"`
      ) {
        let buildSettingsObj = configurations[key].buildSettings;
        buildSettingsObj.DEVELOPMENT_TEAM = devTeam;
        buildSettingsObj.IPHONEOS_DEPLOYMENT_TARGET = iPhoneDeploymentTarget ?? IPHONEOS_DEPLOYMENT_TARGET;
        buildSettingsObj.TARGETED_DEVICE_FAMILY = TARGETED_DEVICE_FAMILY;
        buildSettingsObj.CODE_SIGN_ENTITLEMENTS = `${targetName}/${targetName}.entitlements`;
        buildSettingsObj.CODE_SIGN_STYLE = "Automatic";
      }
    }

    // Add development teams to both your target and the original project
    xcodeProject.addTargetAttribute("DevelopmentTeam", devTeam, nseTarget);
    xcodeProject.addTargetAttribute("DevelopmentTeam", devTeam);

    fs.writeFileSync(projPath, xcodeProject.writeSync());
  })
}

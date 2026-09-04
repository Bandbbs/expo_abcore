require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'ExpoABCore'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = { :type => 'AGPL-3.0-only', :file => '../LICENSE' }
  s.author           = package['author']
  s.homepage         = package['homepage']
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth', 'Security'
  s.source_files = '**/*.{h,swift}'
  s.public_header_files = 'Native/include/*.h'
  s.vendored_frameworks = 'Native/ExpoABCoreRust.xcframework'
  s.resource_bundles = {
    'ExpoABCore' => ['Resources/*']
  }
end

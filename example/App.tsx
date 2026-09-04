import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { listDeviceProfiles } from 'expo-abcore';

export default function App() {
  const [status, setStatus] = useState('Loading native module');

  useEffect(() => {
    listDeviceProfiles()
      .then((profiles) => setStatus(`Saved profiles: ${profiles.length}`))
      .catch((error) => setStatus(String(error)));
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>{status}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

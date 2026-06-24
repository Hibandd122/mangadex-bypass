import 'react-native-url-polyfill/auto';
import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert, Dimensions, StatusBar } from 'react-native';
import * as FileSystem from 'expo-file-system';
import JSZip from 'jszip';
import EventSource from 'react-native-sse';

const BACKEND_URL = "https://mahirun.hicanh69.workers.dev";
const { width } = Dimensions.get('window');

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  
  const [savedChapters, setSavedChapters] = useState([]);
  const [currentChapter, setCurrentChapter] = useState(null); 

  useEffect(() => {
    loadSavedChapters();
  }, []);

  const getChapDir = () => FileSystem.documentDirectory + 'manga_chapters/';

  const loadSavedChapters = async () => {
    const dir = getChapDir();
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    const files = await FileSystem.readDirectoryAsync(dir);
    setSavedChapters(files);
  };

  const handleDownload = async () => {
    if (!url.includes('mangadex.org')) {
      Alert.alert('Lỗi', 'Chỉ hỗ trợ link MangaDex');
      return;
    }
    setLoading(true);
    setStatus('Đang gửi yêu cầu Batch...');
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("url", url);
      formData.append("prompt_mode", "none");
      
      await fetch(`${BACKEND_URL}/manga-auto-exec`, {
        method: 'POST',
        body: formData,
      });

      setStatus('Đang chờ Server dịch...');

      const source = new EventSource(`${BACKEND_URL}/manga-progress`);
      
      source.addEventListener('message', async (event) => {
        if (!event.data) return;
        try {
          const data = JSON.parse(event.data);
          setStatus(data.current || 'Đang xử lý...');
          if (data.total > 0) setProgress(data.done / data.total);

          if (data.status === 'complete' || data.status === 'error') {
            source.close();
            if (data.status === 'complete' && data.download_link) {
              await downloadAndExtractZip(data.download_link);
            } else {
              setStatus('Lỗi dịch trên Server!');
              setLoading(false);
            }
          }
        } catch(e) {}
      });

      source.addEventListener('error', (err) => {
        source.close();
        setStatus('Mất kết nối SSE');
        setLoading(false);
      });

    } catch (error) {
      setStatus('Lỗi kết nối Server');
      setLoading(false);
    }
  };

  const downloadAndExtractZip = async (filename) => {
    try {
      setStatus('Đang tải ZIP về máy...');
      const zipUri = FileSystem.cacheDirectory + filename;
      const downloadRes = await FileSystem.downloadAsync(`${BACKEND_URL}/download/${filename}`, zipUri);
      
      setStatus('Đang bung nén ZIP...');
      const zipB64 = await FileSystem.readAsStringAsync(zipUri, { encoding: FileSystem.EncodingType.Base64 });
      const zip = await JSZip.loadAsync(zipB64, { base64: true });
      
      const chapId = "Chap_" + Date.now();
      const extractDir = getChapDir() + chapId + '/';
      await FileSystem.makeDirectoryAsync(extractDir, { intermediates: true });

      const files = Object.values(zip.files).filter(f => !f.dir);
      files.sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric: true}));

      let count = 0;
      for (const file of files) {
        const base64Data = await file.async("base64");
        await FileSystem.writeAsStringAsync(extractDir + file.name, base64Data, { encoding: FileSystem.EncodingType.Base64 });
        count++;
        setStatus(`Đã lưu ${count}/${files.length} ảnh...`);
      }

      await FileSystem.deleteAsync(zipUri, { idempotent: true });
      
      setStatus('Hoàn tất!');
      setLoading(false);
      setUrl('');
      loadSavedChapters();
      
      openChapter(chapId);
    } catch(e) {
      setStatus('Lỗi giải nén: ' + e.message);
      setLoading(false);
    }
  };

  const openChapter = async (chapId) => {
    const dir = getChapDir() + chapId + '/';
    const files = await FileSystem.readDirectoryAsync(dir);
    files.sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
    const uris = files.map(f => dir + f);
    setCurrentChapter(uris);
  };

  const deleteChapter = async (chapId) => {
    const dir = getChapDir() + chapId;
    await FileSystem.deleteAsync(dir, { idempotent: true });
    loadSavedChapters();
  };

  if (currentChapter) {
    return (
      <View style={styles.readerContainer}>
        <StatusBar hidden />
        <TouchableOpacity style={styles.closeBtn} onPress={() => setCurrentChapter(null)}>
          <Text style={styles.closeBtnText}>ĐÓNG LẠI (X)</Text>
        </TouchableOpacity>
        <FlatList
          data={currentChapter}
          keyExtractor={(item, idx) => idx.toString()}
          renderItem={({item}) => (
            <Image source={{uri: item}} style={{width: width, height: width * 1.5}} resizeMode="contain" />
          )}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>NEXUS MANGA</Text>
      
      <View style={styles.inputBox}>
        <TextInput 
          style={styles.input} 
          placeholder="Dán link MangaDex..." 
          placeholderTextColor="#64748b"
          value={url}
          onChangeText={setUrl}
          editable={!loading}
        />
        <TouchableOpacity style={styles.btn} onPress={handleDownload} disabled={loading}>
          <Text style={styles.btnText}>{loading ? 'ĐANG XỬ LÝ...' : 'TẢI & DỊCH BATCH'}</Text>
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.progressBox}>
          <ActivityIndicator color="#00e5ff" />
          <Text style={styles.statusText}>{status}</Text>
          <View style={styles.barBg}>
            <View style={[styles.barFill, {width: `${progress * 100}%`}]} />
          </View>
        </View>
      )}

      <Text style={styles.subtitle}>THƯ VIỆN ĐÃ LƯU</Text>
      <FlatList
        data={savedChapters}
        keyExtractor={item => item}
        style={{width: '100%'}}
        renderItem={({item}) => (
          <View style={styles.chapCard}>
            <TouchableOpacity style={styles.chapBtn} onPress={() => openChapter(item)}>
              <Text style={styles.chapText}>📂 {item}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.delBtn} onPress={() => deleteChapter(item)}>
              <Text style={styles.delText}>XÓA</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0c10', padding: 20, paddingTop: 60, alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#00e5ff', marginBottom: 20, fontFamily: 'Courier New' },
  inputBox: { width: '100%', marginBottom: 20 },
  input: { backgroundColor: '#111', color: '#00e5ff', padding: 15, borderRadius: 10, borderWidth: 1, borderColor: '#00e5ff', marginBottom: 10 },
  btn: { backgroundColor: '#00e5ff', padding: 15, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#000', fontWeight: 'bold', fontSize: 16 },
  progressBox: { width: '100%', padding: 20, backgroundColor: '#111', borderRadius: 10, borderWidth: 1, borderColor: '#f59e0b', marginBottom: 20, alignItems: 'center' },
  statusText: { color: '#f59e0b', marginTop: 10, fontSize: 12 },
  barBg: { width: '100%', height: 6, backgroundColor: '#333', borderRadius: 3, marginTop: 10, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#f59e0b' },
  subtitle: { color: '#e2e8f0', fontSize: 14, fontWeight: 'bold', alignSelf: 'flex-start', marginBottom: 10, marginTop: 10 },
  chapCard: { flexDirection: 'row', backgroundColor: '#111', padding: 15, borderRadius: 10, marginBottom: 10, alignItems: 'center', justifyContent: 'space-between', width: '100%', borderWidth: 1, borderColor: '#333' },
  chapBtn: { flex: 1 },
  chapText: { color: '#00e5ff', fontSize: 14, fontWeight: 'bold' },
  delBtn: { backgroundColor: 'rgba(244, 63, 94, 0.2)', padding: 8, borderRadius: 5, borderWidth: 1, borderColor: '#f43f5e' },
  delText: { color: '#f43f5e', fontSize: 12, fontWeight: 'bold' },
  readerContainer: { flex: 1, backgroundColor: '#000' },
  closeBtn: { position: 'absolute', top: 40, right: 20, zIndex: 10, backgroundColor: 'rgba(0,229,255,0.2)', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#00e5ff' },
  closeBtnText: { color: '#00e5ff', fontWeight: 'bold' }
});
